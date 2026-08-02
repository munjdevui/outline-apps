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
import * as assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import * as os from 'os';
import * as path from 'path';

import {KillSwitchStore} from './kill_switch_store';

describe('KillSwitchStore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-kill-switch-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  it('returns false when no preference has been saved', async () => {
    const store = new KillSwitchStore(tempDir);
    assert.equal(await store.load(), false);
  });

  it('persists enabled preference', async () => {
    const store = new KillSwitchStore(tempDir);
    await store.save(true);
    assert.equal(await store.load(), true);
  });

  it('persists disabled preference', async () => {
    const store = new KillSwitchStore(tempDir);
    await store.save(true);
    await store.save(false);
    assert.equal(await store.load(), false);
  });

  it('returns false when the store file is corrupt', async () => {
    const store = new KillSwitchStore(tempDir);
    fs.writeFileSync(path.join(tempDir, 'kill_switch_store'), '{not-json');
    assert.equal(await store.load(), false);
  });
});
