// 单项检查的纯判定：卡片字段清单、幕纲峰值强度取值、剧情线缺席。
// 只回答「这一项合不合契约」，不读文件、不报错；错误码与判定顺序留在 validate-output.mjs。
import { ENUMS, tableColumns } from '../contract.mjs'

// 卡片字段清单：每类卡必须出现且非空的字段标签。
// 放在模块顶层是为了能被测试 import——清单与模板脱节时（#20 把「原型词/功能位」拆成两行
// 却没同步这里）测试才抓得到；写在函数体里就永远只能靠夹具碰巧写对。
export const CARD_FIELDS = {
  人物: [
    '姓名（主名）', '别称与马甲', '归属势力', '力量/成长坐标', '首次出场章', '关键章节链',
    '核心关系', '说话风格与人设锚点', '体貌锚点', '衣着与装束', '神态与动作锚',
    '外在目标（要什么）', '内在缺口（缺什么）', '致命弱点（会毁在哪）',
    // 「原型词」与「功能位」在模板里是两行（#20 把原来合并的一行拆开了）：
    // 功能位是闭合枚举、必填；原型词自由填。这里必须按两行查——
    // 沿用旧的合并标签「原型词/功能位」会让每一张按模板填的卡都报「缺 1 个字段标签」。
    '原型词', '功能位',
    '结局状态与死亡/退场章', '金句锚',
  ],
  势力与组织: ['名称与俗称', '性质类型', '所在地/据点', '层级结构', '成员表', '势力关系', '与主角关系及演变', '首次出场章', '关键事件章', '状态变化', '结局'],
  地点: ['名称', '别名与真名揭示章', '所属区域', '功能与象征意义', '空间规则', '关联人物与势力', '首次出场章', '进入章', '状态轨迹'],
  物品: ['名称', '类别', '强度等级', '能力与代价', '获得章', '经手与流转链', '象征义', '结局'],
  概念: ['名称', '一句话定义', '首次系统阐释章', '规则细节', '上位/下位概念', '揭示节奏', '与主角的关系'],
}

// 从幕纲「情绪基调与走向」段取出峰值强度注记（M-09）。
//
// 返回：
//   null                 —— 没写峰值，或写的「无」／占位符（不算错，也不算记了）
//   { value, ok: true }  —— 写了且在 ENUMS.峰值强度 内
//   { value, ok: false } —— 写了但不在枚举内（调用方报 E_ENUM）
//
// 为什么单独抽出来：内联在校验循环里时，测试只能断「源码提到过 ENUMS.峰值强度」，
// 而把判定换成写死的四个字后，上方错误信息里的 join(…) 仍然匹配——那种断言
// 断的是「有没有提到」，不是「还做不做这件事」（变异实测就是这么漏的）。
export function peakIntensityOf(toneText) {
  const m = /峰值\s*[：:]\s*([^\n；;，,）)]{0,24})/.exec(String(toneText ?? ''))
  if (!m) return null
  // 先剥 Markdown 强调符：真书实测的写法是「- 幕中峰值：**爽**（第8章康履伏诛…）」。
  // 不剥的话 val 变成「**爽**（第8章…」，startsWith 判不出来，一个填对了的产物被判非法取值。
  // 强调符是排版，不是取值；同一条容忍也适用于反引号与下划线。
  const raw = m[1].replace(/[*_`]/g, '').trim()
  // 占位符要先判：正则的字符类排掉了「）」，取值会被截成「（待填」，
  // 于是 val === '（待填）' 永远不成立，骨架态会被报成非法取值。
  if (!raw || raw.includes('待填')) return null
  const val = raw.replace(/[（(]\s*$/, '')
  if (!val || /^无/.test(val)) return null
  // 合法写法只有两种：整词（「燃」）或「枚举词＋括注」（「燃（对抗升级）」「喜/关系缓和」）。
  // 判据是「枚举词之后要么结束、要么紧接着一个分隔符」：
  // 用 includes 会放过「喜悦」「大爽点」；用 startsWith 会放过「喜悦」——两种都宁可放过，
  // 而这里要的是「写了别的词就报」，因为逐章记录的同名列是用 E_ENUM 严格拒的。
  const SEP = '（(／/、,，·—－-'
  const ok = ENUMS.峰值强度.some((e) => val === e || (val.startsWith(e) && SEP.includes(val[e.length])))
  return { value: val, ok }
}

// 剧情线缺席检测（Q-22，纯函数）：chapterRows 为逐章记录的表格数据行（parseRow 解析后的单元格数组）。
// 对在 ≥3 行出现过的每个线名（一章多线以「、」分隔），若相邻两次出现间隔 > threshold 章（按全局章号差），
// 返回 {线名, 上次章号, 缺席章数}；缺席章数＝两次出现的全局章号差。
export function findLineGaps(chapterRows, threshold) {
  const cols = tableColumns('逐章记录')
  const noIdx = cols.indexOf('全局章号')
  const lineIdx = cols.indexOf('剧情线')
  const seen = new Map() // 线名 → 出现章号（升序）
  for (const row of chapterRows) {
    const no = Number(/(\d+)/.exec(String(row?.[noIdx] ?? ''))?.[1] ?? NaN)
    if (!Number.isFinite(no)) continue
    const cell = String(row?.[lineIdx] ?? '').trim()
    if (!cell || cell.includes('待填') || cell === '无') continue
    for (const name of cell.split('、').map((s) => s.trim()).filter(Boolean)) {
      if (!seen.has(name)) seen.set(name, [])
      seen.get(name).push(no)
    }
  }
  const gaps = []
  for (const [name, nos] of seen) {
    if (nos.length < 3) continue // 出现不足 3 行的线不判缺席
    nos.sort((a, b) => a - b)
    for (let i = 1; i < nos.length; i++) {
      const absent = nos[i] - nos[i - 1]
      if (absent > threshold) gaps.push({ 线名: name, 上次章号: nos[i - 1], 缺席章数: absent })
    }
  }
  return gaps.sort((a, b) => a.上次章号 - b.上次章号)
}
