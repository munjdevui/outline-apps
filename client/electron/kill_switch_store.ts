// Copyright 2026 The Outline Authors
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

import * as fs from 'fs';
import * as path from 'path';

/**
 * Persistence for the Windows kill switch preference.
 *
 * Stored in the Electron main-process userData directory so the setting is
 * available at auto-connect time, before the renderer has loaded.
 */
export class KillSwitchStore {
  private readonly storagePath: string;

  constructor(storagePath: string) {
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, {recursive: true});
    }
    this.storagePath = path.join(storagePath, 'kill_switch_store');
  }

  async load(): Promise<boolean> {
    return new Promise(resolve => {
      fs.readFile(this.storagePath, 'utf8', (error, data) => {
        if (error || !data) {
          resolve(false);
          return;
        }
        try {
          const parsed = JSON.parse(data) as {enabled?: boolean};
          resolve(parsed.enabled === true);
        } catch {
          resolve(false);
        }
      });
    });
  }

  async save(enabled: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.writeFile(
        this.storagePath,
        JSON.stringify({enabled}),
        'utf8',
        error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  }
}
