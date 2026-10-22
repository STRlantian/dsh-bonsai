import { readFileSync, writeFileSync } from 'node:fs'

/** The last three settings strings that the pattern-based pass missed. */

const path = 'D:/dsh-token-tree/client/client.js'
let text = readFileSync(path, 'utf8')

const swaps = [
  {
    from: `setNote('已保存：' + key + ' = ' + (value === null ? t('跟随配置') : String(value)))`,
    to: `setNote(tf('已保存：{} = {}', key, value === null ? t('跟随配置') : String(value)))`,
  },
  {
    from: `                '这些开关立即生效，写入 ' + (settings.path === null ? t('（未配置）') : settings.path) + '，重启后仍然有效。'),`,
    to: `                tf('这些开关立即生效，写入 {}，重启后仍然有效。', settings.path === null ? t('（未配置）') : settings.path)),`,
  },
]

let applied = 0
for (const { from, to } of swaps) {
  if (!text.includes(from)) {
    console.log('skip:', from.slice(0, 50))
    continue
  }
  text = text.replace(from, to)
  applied++
}

// Phrase for the save toast template.
text = text.replace(
  '  "已保存：{}": "Saved: {}",',
  '  "已保存：{}": "Saved: {}",\n  "已保存：{} = {}": "Saved: {} = {}",',
)

writeFileSync(path, text, 'utf8')
console.log(`applied ${applied}`)
