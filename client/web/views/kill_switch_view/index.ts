/*
 * Copyright 2026 The Outline Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {LitElement, html, css} from 'lit';
import {customElement, property} from 'lit/decorators.js';

import '@material/web/switch/switch.js';

@customElement('kill-switch-view')
export class KillSwitchView extends LitElement {
  @property({type: Boolean}) enabled = false;
  @property({type: Object}) localize: (key: string) => string = msg => msg;

  static styles = css`
    :host {
      height: 100%;
      width: 100%;
      background-color: var(--outline-background);
      color: var(--outline-text-color);
      display: block;
      box-sizing: border-box;
      padding: 16px;
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      background-color: var(--outline-card-background);
      border-radius: 8px;
      padding: 16px;
    }

    .copy {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .title {
      font-family: var(--outline-font-family);
      font-size: 16px;
      font-weight: 500;
      color: var(--outline-text-color);
    }

    .detail {
      font-family: var(--outline-font-family);
      font-size: 14px;
      line-height: 1.4;
      color: var(--outline-label-color, var(--outline-text-color));
      opacity: 0.85;
    }

    md-switch {
      --md-switch-selected-track-color: var(--outline-primary);
      --md-switch-selected-handle-color: var(--outline-background);
      flex-shrink: 0;
    }
  `;

  render() {
    return html`
      <div class="row">
        <div class="copy">
          <div class="title">${this.localize('kill-switch-title')}</div>
          <div class="detail">${this.localize('kill-switch-detail')}</div>
        </div>
        <md-switch
          .selected=${this.enabled}
          @change=${this.onToggle}
          aria-label=${this.localize('kill-switch-title')}
        ></md-switch>
      </div>
    `;
  }

  private onToggle(event: Event) {
    const target = event.target as HTMLInputElement & {selected: boolean};
    this.enabled = target.selected;
    this.dispatchEvent(
      new CustomEvent('SetKillSwitchRequested', {
        bubbles: true,
        composed: true,
        detail: {
          enabled: this.enabled,
        },
      })
    );
  }
}
