// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {createConnection, Socket} from 'net';
import {platform} from 'os';
import * as path from 'path';

import * as sudo from 'sudo-prompt';

import {pathToEmbeddedOutlineService} from './app_paths';
import {TunnelStatus} from '../web/app/outline_server_repository/vpn';
import {ErrorCode} from '../web/model/errors';
import {PlatformError, GoErrorCode} from '../web/model/platform_error';

const isWindows = platform() === 'win32';
const SERVICE_NAME = '\\\\.\\pipe\\OutlineServicePipe';

interface RoutingServiceRequest {
  action: string;
  parameters: {[parameter: string]: string | boolean};
}

interface RoutingServiceResponse {
  action: RoutingServiceAction; // Matches RoutingServiceRequest.action
  statusCode: RoutingServiceStatusCode;
  errorMessage?: string;
  connectionStatus: TunnelStatus;
  gatewayAdapterIndex?: string;
}

enum RoutingServiceAction {
  CONFIGURE_ROUTING = 'configureRouting',
  RESET_ROUTING = 'resetRouting',
  ENTER_LOCKDOWN = 'enterLockdown',
  STATUS_CHANGED = 'statusChanged',
}

export interface RoutingStopOptions {
  /**
   * When false and on Windows, ask OutlineService to enter kill-switch lockdown
   * (block all traffic) instead of restoring the system routing table.
   * Defaults to true (restore routing / allow internet).
   */
  releaseKillSwitch?: boolean;
}

enum RoutingServiceStatusCode {
  SUCCESS = 0,
  GENERIC_FAILURE = 1,
  UNSUPPORTED_ROUTING_TABLE = 2,
}

// Communicates with the Outline routing daemon via a Windows named pipe.
//
// A minimal life-cycle is supported:
//  - CONFIGURE_ROUTING is *always* the first message sent on the pipe.
//  - Subsequent supported operations are RESET_ROUTING or ENTER_LOCKDOWN.
//  - In the meantime, the client may receive zero or more STATUS_CHANGED events.
//
// That's it! This helps us connect to the service for *as short a time as possible*, which is
// important since only one client may be connected to the Windows service at any given time.
//
// To test:
//  - Windows: net start|stop OutlineService
export class RoutingDaemon {
  private socket: Socket | null | undefined;

  private stopping = false;

  private fulfillDisconnect!: () => void;

  private disconnected = new Promise<void>(F => {
    this.fulfillDisconnect = F;
  });

  private networkChangeListener?: (
    status: TunnelStatus,
    gatewayIndex?: string
  ) => void;

  constructor(
    private proxyAddress: string,
    private isAutoConnect: boolean
  ) {}

  // Fulfills once a connection is established with the routing daemon *and* it has successfully
  // configured the system's routing table.
  // Returns a string representing the network adapter index that connects to the gateway.
  async start() {
    return new Promise<string>((fulfill, reject) => {
      const newSocket = (this.socket = createConnection(SERVICE_NAME, () => {
        newSocket.removeListener('error', initialErrorHandler);
        const cleanup = () => {
          newSocket.removeAllListeners();
          this.socket = null;
          this.fulfillDisconnect();
        };
        newSocket.once('close', cleanup);
        newSocket.once('error', cleanup);

        newSocket.once('data', data => {
          const message = this.parseRoutingServiceResponse(data);
          if (
            !message ||
            message.action !== RoutingServiceAction.CONFIGURE_ROUTING ||
            message.statusCode !== RoutingServiceStatusCode.SUCCESS
          ) {
            // NOTE: This will rarely occur because the connectivity tests
            //       performed when the user clicks "CONNECT" should detect when
            //       the system is offline and that, currently, is pretty much
            //       the only time the routing service will fail.
            reject(
              new Error(
                message
                  ? message.errorMessage
                  : 'empty routing service response'
              )
            );
            newSocket.end();
            return;
          }

          newSocket.on('data', this.dataHandler.bind(this));

          // Potential race condition: this routing daemon might already be stopped by the tunnel
          // when one of the dependencies (ss-local/tun2socks) exited
          // TODO(junyi): better handling this case in the next installation logic fix
          if (this.stopping) {
            cleanup();
            newSocket.destroy();
            const perr = new PlatformError(
              GoErrorCode.ROUTING_SERVICE_NOT_RUNNING,
              'routing daemon service stopped before started'
            );
            reject(new Error(perr.toJSON()));
          } else {
            fulfill(message.gatewayAdapterIndex);
          }
        });

        newSocket.write(
          JSON.stringify({
            action: RoutingServiceAction.CONFIGURE_ROUTING,
            parameters: {
              proxyIp: this.proxyAddress,
              isAutoConnect: this.isAutoConnect,
            },
          } as RoutingServiceRequest)
        );
      }));

      const initialErrorHandler = (err: Error) => {
        console.error('Routing daemon socket setup failed', err);
        this.socket = null;
        const perr = new PlatformError(
          GoErrorCode.ROUTING_SERVICE_NOT_RUNNING,
          'routing daemon is not running',
          {cause: err}
        );
        reject(new Error(perr.toJSON()));
      };
      newSocket.once('error', initialErrorHandler);
    });
  }

  private dataHandler(data: Buffer) {
    const message = this.parseRoutingServiceResponse(data);
    if (!message) {
      return;
    }
    switch (message.action) {
      case RoutingServiceAction.STATUS_CHANGED:
        if (this.networkChangeListener) {
          this.networkChangeListener(
            message.connectionStatus,
            message.gatewayAdapterIndex
          );
        }
        break;
      case RoutingServiceAction.RESET_ROUTING:
      case RoutingServiceAction.ENTER_LOCKDOWN:
        // TODO: examine statusCode
        if (this.socket) {
          this.socket.end();
        }
        break;
      default:
        console.error(
          `unexpected message from background service: ${data.toString()}`
        );
    }
  }

  // Parses JSON `data` as a `RoutingServiceResponse`. Logs the error and returns undefined on
  // failure.
  private parseRoutingServiceResponse(
    data: Buffer
  ): RoutingServiceResponse | undefined {
    if (!data) {
      console.error('received empty response from routing service');
      return undefined;
    }
    let response: RoutingServiceResponse | undefined = undefined;
    try {
      response = JSON.parse(data.toString());
    } catch {
      console.error(
        `failed to parse routing service response: ${data.toString()}`
      );
    }
    return response;
  }

  private async writeAction(action: RoutingServiceAction) {
    return new Promise<void>((resolve, reject) => {
      const written = this.socket?.write(
        JSON.stringify({
          action,
          parameters: {},
        } as RoutingServiceRequest),
        err => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
      if (!written) {
        reject(new Error('Write failed'));
      }
    });
  }

  // stop() resolves when the stop command has been sent.
  // Use #onceDisconnected to be notified when the connection terminates.
  //
  // When releaseKillSwitch is false (Windows kill switch), the routing service
  // enters lockdown instead of restoring internet access.
  async stop(options: RoutingStopOptions = {}) {
    const releaseKillSwitch = options.releaseKillSwitch !== false;
    const stopAction = releaseKillSwitch
      ? RoutingServiceAction.RESET_ROUTING
      : RoutingServiceAction.ENTER_LOCKDOWN;

    if (!this.socket) {
      // Never started, or the pipe already dropped. If kill switch should stay
      // active, open a one-shot connection to enter lockdown.
      if (!releaseKillSwitch && isWindows) {
        try {
          await sendRoutingServiceAction(stopAction);
        } catch (e) {
          console.error('failed to enter kill switch lockdown:', e);
        }
      }
      this.fulfillDisconnect();
      return;
    }
    if (this.stopping) {
      // Already stopped.
      return;
    }
    this.stopping = true;

    return this.writeAction(stopAction);
  }

  get onceDisconnected() {
    return this.disconnected;
  }

  set onNetworkChange(
    newListener: (
      status: TunnelStatus,
      gatewayIndex?: string
    ) => void | undefined
  ) {
    this.networkChangeListener = newListener;
  }
}

//#region one-shot routing service commands

/**
 * Sends a single action to OutlineService on a fresh pipe connection and waits
 * for the matching response. Used when there is no active RoutingDaemon session
 * (for example, to enter/leave kill-switch lockdown after an unexpected drop).
 */
function sendRoutingServiceAction(action: RoutingServiceAction): Promise<void> {
  if (!isWindows) {
    return Promise.reject(new Error('unsupported os'));
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(SERVICE_NAME, () => {
      socket.once('data', data => {
        socket.end();
        try {
          const message = JSON.parse(data.toString()) as RoutingServiceResponse;
          if (
            message.action === action &&
            message.statusCode === RoutingServiceStatusCode.SUCCESS
          ) {
            resolve();
          } else {
            reject(
              new Error(
                message.errorMessage ||
                  `routing service action ${action} failed`
              )
            );
          }
        } catch (e) {
          reject(e);
        }
      });
      socket.write(
        JSON.stringify({
          action,
          parameters: {},
        } as RoutingServiceRequest)
      );
    });
    socket.once('error', reject);
  });
}

/** Ask OutlineService to block all traffic (Windows kill switch lockdown). */
export async function enterKillSwitchLockdown(): Promise<void> {
  await sendRoutingServiceAction(RoutingServiceAction.ENTER_LOCKDOWN);
}

/** Restore system routing after kill switch lockdown. */
export async function releaseKillSwitchLockdown(): Promise<void> {
  await sendRoutingServiceAction(RoutingServiceAction.RESET_ROUTING);
}

//#endregion one-shot routing service commands

//#region routing service installation

/**
 * Execute arbitary shell `command` as root.
 * @param command command Any valid shell command(s).
 */
function executeCommandAsRoot(command: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sudo.exec(command, {name: 'Outline'}, (sudoError, stdout, stderr) => {
      console.info(stdout);
      console.error(stderr);

      if (sudoError) {
        // This error message is an un-exported constant defined here:
        //   - https://github.com/jorangreef/sudo-prompt/blob/v9.2.1/index.js#L670
        if (sudoError.message?.includes('did not grant permission')) {
          console.error('user rejected to run command as root');
          reject(ErrorCode.NO_ADMIN_PERMISSIONS);
        } else {
          console.error('command is running as root but failed: ', sudoError);
          reject(ErrorCode.UNEXPECTED);
        }
      } else {
        resolve();
      }
    });
  });
}

function installWindowsRoutingServices(): Promise<void> {
  const WINDOWS_INSTALLER_FILENAME = 'install_windows_service.bat';

  // Locating the script is tricky: when packaged, this basically boils down to:
  //   c:\program files\Outline\
  // but during development:
  //   build/windows
  //
  // Surrounding quotes important, consider "c:\program files"!
  const script = `"${path.join(
    pathToEmbeddedOutlineService(),
    WINDOWS_INSTALLER_FILENAME
  )}"`;
  return executeCommandAsRoot(script);
}

export async function installRoutingServices(): Promise<void> {
  console.info('installing outline routing service...');
  if (!isWindows) {
    throw new Error('unsupported os');
  }
  await installWindowsRoutingServices();
  console.info('outline routing service installed successfully');
}

//#endregion routing service installation
