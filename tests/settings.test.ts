import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { SettingsStore } from '../src/plugin/settings.ts'

/** A store backed by a throwaway directory. */
function tempStore(): { store: SettingsStore; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tt-settings-'))
  const path = join(dir, 'settings.json')
  return { store: new SettingsStore({ path, onError: () => {} }), path, dir }
}

test('settings start empty and keep only well-typed values', () => {
  const { store, dir } = tempStore()
  try {
    assert.deepEqual(store.all(), {})
    store.apply({ autoInject: 'yes', hintMinNodes: -3, retrievalHint: true, noise: 1 })
    // Only the valid key survives; unknown keys and bad types are ignored.
    assert.deepEqual(store.all(), { retrievalHint: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings persist and reload in a new store instance', () => {
  const { store, path, dir } = tempStore()
  try {
    store.apply({ autoInject: true, hintMinNodes: 12 })
    const text = readFileSync(path, 'utf8')
    assert.ok(text.includes('"autoInject": true'))
    const reloaded = new SettingsStore({ path, onError: () => {} })
    assert.deepEqual(reloaded.all(), { autoInject: true, hintMinNodes: 12 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a null value clears an override so the profile config applies again', () => {
  const { store, dir } = tempStore()
  try {
    store.apply({ autoInject: true, retrievalHint: false })
    assert.deepEqual(store.all(), { autoInject: true, retrievalHint: false })
    store.apply({ autoInject: null })
    assert.deepEqual(store.all(), { retrievalHint: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt settings file is ignored rather than fatal', () => {
  const { path, dir } = tempStore()
  try {
    writeFileSync(path, '{ not json', 'utf8')
    const store = new SettingsStore({ path, onError: () => {} })
    assert.deepEqual(store.all(), {})
    // It still saves afterwards, repairing the file.
    store.apply({ autoInject: false })
    assert.deepEqual(new SettingsStore({ path, onError: () => {} }).all(), { autoInject: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
