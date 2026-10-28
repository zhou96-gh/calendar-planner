import { Solar } from '../vendor/lunar.js';

// 公历清单混有外国专属节日和国际专题日，仅选取国内日历通行的条目。
const DOMESTIC_SOLAR_FESTIVALS = new Set([
  '元旦节', '情人节', '妇女节', '植树节', '消费者权益日', '愚人节',
  '劳动节', '青年节', '儿童节', '建党节', '建军节', '教师节', '国庆节',
  '全国中小学生安全教育日', '母亲节', '全国助残日', '父亲节', '全民国防教育日',
  '中国人民警察节', '京汉铁路罢工纪念日', '全国爱耳日', '中国青年志愿者服务日',
  '女生节', '全国科技人才活动日', '全国爱肝日', '中国黄花岗七十二烈士殉难纪念日',
  '全民国家安全教育日', '中国航天日', '儿童预防接种宣传日', '全国疟疾日',
  '全国交通安全反思日', '全国防灾减灾日', '护士节', '中国旅游日', '网络情人节',
  '525心理健康节', '上海解放日', '中国五卅运动纪念日', '全国爱眼日', '中国人口日',
  '全国土地日', '香港回归纪念日', '七七事变纪念日', '中国航海日', '男人节',
  '全民健身日', '中国医师节', '全国测绘法宣传日', '中国抗日战争胜利纪念日',
  '中华慈善日', '全国拒绝酒驾日', '九一八事变纪念日', '全国爱牙日', '中国烈士纪念日',
  '辛亥革命纪念日', '中国少年先锋队诞辰日', '全国扶贫日', '程序员节', '抗美援朝纪念日',
  '记者节', '全国消防日', '光棍节', '全国交通安全日', '全国法制宣传日',
  '西安事变纪念日', '国家公祭日', '周恩来逝世纪念日', '周恩来诞辰纪念日',
  '邓小平逝世纪念日', '邓小平诞辰纪念日', '孙中山逝世纪念日', '孙中山诞辰纪念日',
  '朱德逝世纪念日', '毛泽东逝世纪念日', '毛泽东诞辰纪念日'
]);
const ADDITIONAL_SOLAR_FESTIVALS = {
  '03-05': ['学雷锋纪念日'],
  '05-30': ['全国科技工作者日'],
  '12-04': ['国家宪法日'],
  '12-20': ['澳门回归纪念日']
};

const FESTIVAL_ALIASES = {
  '元旦节': '元旦',
  '龙头节': '龙抬头',
  '祭灶日': '南方小年',
  '天日': '天公生',
  '地日': '石头节',
  '上元节': '元宵节'
};

const FESTIVAL_PRIORITIES = {
  '元旦': 0,
  '除夕': 0,
  '春节': 0,
  '清明节': 0,
  '劳动节': 0,
  '端午节': 0,
  '中秋节': 0,
  '国庆节': 0,
  '元宵节': 1,
  '龙抬头': 1,
  '七夕节': 1,
  '重阳节': 1,
  '腊八节': 1,
  '北方小年': 1,
  '南方小年': 1,
  '冬至': 1,
  '情人节': 1,
  '妇女节': 1,
  '植树节': 1,
  '愚人节': 1,
  '青年节': 1,
  '儿童节': 1,
  '建党节': 1,
  '建军节': 1,
  '教师节': 1,
  '母亲节': 1,
  '父亲节': 1
};

const festivalCache = new Map();
const lunarCache = new Map();
const festivalDatesCache = new Map();
const festivalDatesPreparations = new Map();

/**
 * 农历显示与节日识别共用离线历法，避免宿主 Intl 版本造成日期不一致。
 */
function getLunarDate(dateKey) {
  if (lunarCache.has(dateKey)) return lunarCache.get(dateKey);

  const [year, month, day] = dateKey.split('-').map(Number);
  const lunar = Solar.fromYmd(year, month, day).getLunar();
  lunarCache.set(dateKey, lunar);
  return lunar;
}

/**
 * 每天完整显示农历月份和日名，保留闰月标识。
 */
export function formatLunarDate(dateKey) {
  const lunar = getLunarDate(dateKey);

  return lunar.getMonthInChinese() + '月' + lunar.getDayInChinese();
}

/**
 * 本地计算节日名称，不生成放假、调休或补班安排。
 * 明细可包含完整民俗项，日期格默认采用常用筛选。
 */
export function getFestivalNames(dateKey, { includeFolk = false } = {}) {
  const cacheKey = `${dateKey}:${includeFolk}`;

  if (festivalCache.has(cacheKey)) return festivalCache.get(cacheKey);

  const lunar = getLunarDate(dateKey);
  const solar = lunar.getSolar();
  const solarNames = [
    ...solar.getFestivals(),
    ...solar.getOtherFestivals()
  ].filter((name) => DOMESTIC_SOLAR_FESTIVALS.has(name));

  const additional = ADDITIONAL_SOLAR_FESTIVALS[dateKey.slice(5)] ?? [];

  const lunarNames = [
    ...lunar.getFestivals(),
    ...lunar.getOtherFestivals()
  ].filter((name) => {
    const commonName = FESTIVAL_ALIASES[name] ?? name;
    return includeFolk || Object.hasOwn(FESTIVAL_PRIORITIES, commonName);
  });

  const names = [...solarNames, ...additional, ...lunarNames];

  const solarTerm = lunar.getJieQi();

  if (solarTerm === '清明') names.push('清明节');

  if (solarTerm === '冬至') names.push('冬至');

  if (solarTerm === '秋分') names.push('中国农民丰收节');

  if (lunar.getMonth() === 12 && lunar.getDay() === 23) names.push('北方小年');

  const normalized = names.map((name) => FESTIVAL_ALIASES[name] ?? name);

  const ordered = [...new Set(normalized)].sort((left, right) => {
    const leftPriority = FESTIVAL_PRIORITIES[left] ?? 2;
    const rightPriority = FESTIVAL_PRIORITIES[right] ?? 2;
    return leftPriority - rightPriority;
  });

  const result = Object.freeze(ordered);
  festivalCache.set(cacheKey, result);
  return result;
}

/**
 * 返回本年各节日的实际日期，供缺少官方安排时分配法定额度。
 */
export function getFestivalDates(year) {
  if (festivalDatesCache.has(year)) return festivalDatesCache.get(year);

  const dates = {};

  for (let solar = Solar.fromYmd(year, 1, 1); solar.getYear() === year; solar = solar.next(1)) {
    const dateKey = solar.toYmd();
    getFestivalNames(dateKey).forEach((name) => { dates[name] = dateKey; });
  }

  const result = Object.freeze(dates);
  festivalDatesCache.set(year, result);
  return result;
}

/**
 * 分任务预热全年节日，共用日期缓存及同年准备任务，不占用一次完整的全年扫描。
 */
export function prepareFestivalDates(year) {
  if (festivalDatesCache.has(year)) return Promise.resolve(festivalDatesCache.get(year));

  if (festivalDatesPreparations.has(year)) return festivalDatesPreparations.get(year);

  const prepare = async () => {
    const dates = {};
    let processed = 0;

    for (let solar = Solar.fromYmd(year, 1, 1); solar.getYear() === year; solar = solar.next(1)) {
      if (processed % 7 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (festivalDatesCache.has(year)) return festivalDatesCache.get(year);
      }

      const dateKey = solar.toYmd();
      getFestivalNames(dateKey).forEach((name) => { dates[name] = dateKey; });
      processed += 1;
    }

    const result = Object.freeze(dates);
    festivalDatesCache.set(year, result);
    return result;
  };

  const pending = prepare().finally(() => festivalDatesPreparations.delete(year));
  festivalDatesPreparations.set(year, pending);
  return pending;
}
