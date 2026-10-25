// M-09（峰值强度进契约）与 M-14（留存机制收口）。
//
// M-09 的坑在于它看起来和总报告决议 12 冲突：「保留扬抑震，爽燃虐喜降为幕纲内部强度副词，
// 不做映射」。两者其实不冲突——决议 12 禁止的是「把爽燃虐喜映射成情绪列的值」，
// 而 M-09 要的是「把峰值注记登记成一个能被校验的枚举」。测试要把这个区分钉住：
// 情绪列仍然只有三值，峰值是另一个字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENUMS, THRESHOLDS, RESERVE_OUT_OF_SCOPE } from '../skills/book-breakdown/scripts/contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

test('M-09：峰值强度是独立枚举，且不在情绪枚举里', () => {
  assert.deepEqual(ENUMS.峰值强度, ['爽', '燃', '虐', '喜'])
  // 关键区分：这四者不能混进情绪枚举，否则「不做映射」就成了空话
  for (const v of ENUMS.峰值强度) {
    assert.ok(!ENUMS.情绪.includes(v), `「${v}」不该出现在情绪枚举里：决议 12 明写不做映射`)
  }
  assert.deepEqual(ENUMS.情绪, ['扬', '抑', '震荡'], '情绪仍只有三值')
})

test('M-09：幕纲模板指向契约键，不再自己写死四个词', () => {
  const t = read('skills/book-breakdown/assets/幕纲模板.md')
  assert.match(t, /ENUMS\.峰值强度/, '模板要指向契约键，不然改契约改不到模板')
  assert.match(t, /ENUMS\.情绪/, '情绪基调也要指向契约键')
  // 反向：不能既有「指向契约」又保留一句独立的「爽／燃／虐／喜」列举——那样两处会漂
  assert.ok(!/峰值可用强度词注记：爽／燃／虐／喜/.test(t), '旧的写死列举要删掉')
})

test('M-09：模板明写峰值不与基调做映射（否则又变成两套取值）', () => {
  const t = read('skills/book-breakdown/assets/幕纲模板.md')
  assert.match(t, /不是情绪的第四个值|不做映射|不与.*做映射/, '要把这层关系写清楚')
})

test('M-14：留存机制的两个量有契约键，不是只写在文档里', () => {
  // 阈值写在 THRESHOLDS 里，校验与模板才能引用同一个数。
  assert.equal(typeof THRESHOLDS.舒适爽点密度下限, 'number', '爽点密度要有下限')
  assert.equal(typeof THRESHOLDS.拖沓钩连续上限, 'number', '连续同型钩要有上限')
})

test('M-14：范围外四项各自写明理由，且理由不是「暂缓」', () => {
  const keys = Object.keys(RESERVE_OUT_OF_SCOPE)
  assert.deepEqual(keys.sort(), ['章末钩强度以外的钩型细分', '换图时机', '情绪兑现', '期待感三维'].sort(),
    '四项要一一对应清单')
  for (const [k, why] of Object.entries(RESERVE_OUT_OF_SCOPE)) {
    assert.ok(why.length >= 20, `「${k}」的理由太短，写不出可复核的原因`)
    assert.ok(!/暂缓|以后再说|待定/.test(why), `「${k}」的理由不能是「${why}」——那和漏了没区别`)
  }
})

test('M-14：卷纲模板写明只记两个量，并指向范围外清单', () => {
  const t = read('skills/book-breakdown/assets/卷纲模板.md')
  assert.match(t, /爽点密度/, '要写爽点密度')
  assert.match(t, /章末钩强度/, '要写章末钩强度')
  assert.match(t, /RESERVE_OUT_OF_SCOPE/, '范围外要有指向，不能只是不提')
})

test('M-14：卷纲模板点名的四项与契约的范围外清单一致（防止两边漂）', () => {
  const t = read('skills/book-breakdown/assets/卷纲模板.md')
  // 两边的措辞不完全一致（契约键是完整的「章末钩强度以外的钩型细分」，模板里简写成「钩型再细分」），
  // 所以按「核心词」比对。核心词取键里最前面那个具体名词。
  const CORE = {
    期待感三维: '期待感三维',
    情绪兑现: '情绪兑现',
    换图时机: '换图时机',
    章末钩强度以外的钩型细分: '钩型',
  }
  for (const k of Object.keys(RESERVE_OUT_OF_SCOPE)) {
    assert.ok(t.includes(CORE[k]), `模板未提到范围外项「${k}」（找的是「${CORE[k]}」）`)
  }
})

test('M-09：峰值强度纯函数校验（取值合法性，不依赖完整产物）', async () => {
  // 第一版断的是「源码里有 ENUMS.峰值强度」——变异把检查体换成写死数组后，
  // 上方那句错误信息里还留着 ENUMS.峰值强度.join(...)，照样匹配。
  // 断源码等于断「有没有提到」，而回归要防的是「那件事还做不做」。
  //
  // 夹具里没有幕纲（合成小书只到卷纲），所以不走 CLI，直接测导出的纯函数。
  const { peakIntensityOf } = await import('../skills/book-breakdown/scripts/validate-output.mjs')
  assert.equal(typeof peakIntensityOf, 'function', '校验器要导出峰值解析纯函数')
  assert.deepEqual(peakIntensityOf('入幕：扬；峰值：燃；出口：抑'), { value: '燃', ok: true })
  assert.deepEqual(peakIntensityOf('峰值：怪'), { value: '怪', ok: false }, '枚举外的取值要判不合法')
  assert.equal(peakIntensityOf('入幕：扬；出口：抑'), null, '没写峰值时返回 null，不算错')
  assert.equal(peakIntensityOf('峰值：无'), null, '写「无」等于没写，不是非法值')
  assert.equal(peakIntensityOf('峰值：（待填）'), null, '占位符跳过，别把骨架报成错')
  // 枚举必须来自 contract，不能在这里另写一份 ['爽','燃','虐','喜']。
  // 只测「这四个词能用」是测不出来的：写死数组与读契约的行为完全一致，
  // 而「两处各写一份」正是以后会漂的起点。所以直接看函数体：它得提到 ENUMS.峰值强度。
  assert.match(peakIntensityOf.toString(), /ENUMS\.峰值强度/,
    '峰值判定必须读契约枚举；写死一份的话，契约加词时这里不会跟着变')
})
