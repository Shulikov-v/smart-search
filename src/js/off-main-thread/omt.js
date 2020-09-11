importScripts('https://cdn.jsdelivr.net/npm/comlink@4.3.0/dist/umd/comlink.min.js');
importScripts('https://cdn.jsdelivr.net/npm/immer@7.0.8/dist/immer.umd.production.min.js');

const logr = (realm) => {
  const style = 'color:#fff;display:block';
  return {
    info: (...msgs) => {
      console.log(`%c Smart-Search (${realm}) %c`, `background:#333;${style}`, '', ...msgs);
    },
    error: (...msgs) => {
      console.error(`%c Smart-Search (${realm}) %c`, `background:darkred;${style}`, '', ...msgs);
    },
    warn: (...msgs) => {
      console.warn(`%c Smart-Search (${realm}) %c`, `background:darkgoldenrod;${style}`, '', ...msgs);
    }
  };
};

const { info } = logr('Worker');

/**
 * array-view and array-partition
 */
const arrayviewer = (anArray) => {
  const arrayview = () => ({
    start: 0,
    end: anArray.length,
    length: anArray.length - 0,
    get(index) {
      return anArray[this.start + index];
    },
    toArray() {
      return anArray.slice(this.start, this.end + 1);
    },
    viewAs(dStart, dEnd) {
      this.start = dStart;
      this.end = dEnd || this.end;
      this.length = this.end - this.start;
      info(`down to [${this.start}, ${this.end}] with ${this.length} items`);
      return this;
    }
  });

  const view = arrayview();
  const arraypartition = (opts = {}) => {
    const { at: pivot } = opts;
    const pivotIndex = pivot || Math.floor(view.length / 2);
    info(`${view.length} items`);
    return {
      midIndex: pivotIndex,
      midItem: view.get(pivotIndex),
      left: () => view.viewAs(view.start, (view.start + pivotIndex) - 1),
      right: () => view.viewAs((view.start + pivotIndex) + 1)
    };
  };
  view.partition = arraypartition;

  return { ...view };
};

/**
 * State management with immer
 */
let STATE = {
  query: '',
  queryMatches: [],
  sorted: {
    byYearOfBirth: []
  },
  staging: [],
  developers: {}
};

const getState = () => STATE;
const setState = (fn) => {
  STATE = immer.produce(STATE, fn);
  return STATE;
};

const getMonths = () => [
  ['Jan', 'January'],
  ['Feb', 'February'],
  ['Mar', 'March'],
  ['Apr', 'April'],
  ['May', 'May'],
  ['Jun', 'June'],
  ['Jul', 'July'],
  ['Aug', 'August'],
  ['Sept', 'September'],
  ['Oct', 'October'],
  ['Nov', 'November'],
  ['Dec', 'December']
];

/**
 * Search engines
 */
const searchByFaningOut = (payload) => {
  const { midIndex, data, isEQ } = payload;
  const start = data.start + midIndex;
  info(`fanning out @ [${midIndex}], which resolves to [${start}]`);
  info(`your results should be the closest neighbours of [${start}] ....`);

  let left = midIndex;
  let right = midIndex;

  while (left > 0) {
    if (isEQ(data.get(left - 1))) {
      left -= 1;
    } else {
      break;
    }
  }

  while (right < data.length) {
    if (isEQ(data.get(right + 1))) {
      right += 1;
    } else {
      break;
    }
  }

  const effectiveLeft = start - (midIndex - left);
  // Add 1 to make room in effectiveRight for
  // array.slice() which is what .toArray() uses
  const effectiveRight = start + (right - midIndex) + 1;
  return data.viewAs(effectiveLeft, effectiveRight).toArray().filter(isEQ);
};

const runBinarySearch = (payload) => {
  const { data, isEQ, isGT } = payload;
  const itemsLen = data.length;

  // At below 5 items, not sure there's need to further
  // split the sorted (data) array, we can just quickly filter
  // for our matches. Need a way to determine what 5 should be.
  if (itemsLen <= 5) return data.toArray().filter(isEQ);

  const partition = data.partition();
  const { midItem, midIndex } = partition;
  if (isEQ(midItem) === true) {
    return searchByFaningOut({
      midIndex,
      data,
      isEQ
    });
  }

  const { left, right } = partition;
  info(`pivoting @ [${midIndex}]`);
  const dataView = isGT(midItem) === true ? left() : right();
  return runBinarySearch({
    isEQ,
    isGT,
    data: dataView
  });
};

const searchByYearOfBirth = (query) => {
  // This can currently only search with
  // = (e.g @dob = 1990). TODO: add support
  // for !=, >, >=, <, <=
  const qry = (query.split(/=\s*/)[1] || '').trim();

  // search by 4 digit year, e.g 1985
  if (/\d{4}/.test(qry)) {
    info('searching by year');
    const queryYear = parseInt(qry, 10);
    const isGT = ({ yob }) => yob > queryYear;
    const isEQ = ({ yob }) => yob === queryYear;
    const isLTE = ({ yob }) => yob <= queryYear;
    const data = arrayviewer(getState().sorted.byYearOfBirth);

    return runBinarySearch({
      isEQ,
      isGT,
      isLTE,
      data
    });
  }

  return [];
};

const searchByMonthOfBirth = (query) => [query];

const engines = [
  {
    type: 'byYearOfBirth',
    // match @dob = 1985
    matcher: /^@dob\s*=\s*\d{4}$/i,
    sorter: (devA, devB) => devA.bio.dob - devB.bio.dob,
    indexer: (dev) => {
      const yob = dev.bio.dob.getFullYear();
      return { id: dev.id, yob };
    },
    search: searchByYearOfBirth
  },
  {
    type: 'byMonthOfBirth',
    // TODO change this: match @dob = Aug | August
    matcher: /^@dob\s*=\s*[a-z]{3,}$/i,
    sorter: (devA, devB) => devA.bio.dob.getMonth() - devB.bio.dob.getMonth(),
    indexer: (dev) => {
      const months = getMonths();
      const mob = months[dev.bio.dob.getMonth()];
      return { id: dev.id, mob };
    },
    search: searchByMonthOfBirth
  }
];

/**
 * OMT processing
 */

const sortDevs = async (developers) => {
  const devs = developers.slice();
  engines.forEach(({ type, sorter, indexer }) => {
    const sorted = devs.sort(sorter);
    setState((draft) => {
      draft.sorted[`${type}`] = sorted.map(indexer);
    });
  });
  // info(getState().sorted.byYearOfBirth);
};

const dataToDev = (dev) => {
  const { bio } = dev;
  const months = getMonths();

  bio.dob = new Date(bio.dob);
  bio.yob = bio.dob.getFullYear();
  bio.mob = months[bio.dob.getMonth()];
  const thisYr = new Date().getFullYear();
  bio.age = thisYr - bio.yob;

  const names = bio.name.split(' ');
  bio.shortName = `${names[0]} ${names[1].charAt(0).toUpperCase()}.`;

  dev.bio = bio;
  // dev.domString = devToDOMString(dev);
  return dev;
};

const makeDevs = (devs, sink) => devs.reduce((processed, dev) => {
  if (dev) processed[dev.id] = dataToDev(dev);
  return processed;
}, sink);

const processDeveloperData = async (payload = {}) => {
  const { pageSize, developers = [], isFirstPage = false } = payload;

  let devs = developers;
  if (isFirstPage === true) {
    devs = developers.slice(0, pageSize);
    setState((draft) => {
      makeDevs(devs, draft.developers);
      // put the remainder into a staging area
      // for future processing
      draft.staging = developers.slice(pageSize);
    });

    const state = getState();
    const devsToRender = Object.values(state.developers);
    return { devsToRender };
  }

  setState((draft) => {
    if (draft.staging.length > 0) devs = [...draft.staging, ...devs];
    makeDevs(devs, draft.developers);

    // empty the statging area after
    // processing all devs records
    draft.staging = [];
  });

  // TODO dont sort the entire collection every time!!
  const state = getState();
  sortDevs(Object.values(state.developers));
  return { devsCount: Object.keys(state.developers).length };
};

const runQuery = async (query) => {
  info(query);
  const engine = engines.find(({ matcher }) => matcher && matcher.test(query) === true);
  if (!engine) return []; // no matches found

  setState((draft) => {
    draft.query = query;
  });

  const matchingIndexes = engine.search(query);
  info(`found ${matchingIndexes.length} matches ...`);

  if (matchingIndexes && matchingIndexes.length > 0) {
    const gatherer = new Array(matchingIndexes.length);
    const matched = matchingIndexes.reduce((matches, { id }, pos) => {
      const state = getState();
      const dev = state.developers[`${id}`];
      if (dev) matches[pos] = dev.domString;
      return matches;
    }, gatherer);

    setState((draft) => {
      draft.queryMatches = matched;
    });

    const state = getState();
    return state.queryMatches;
  }

  return []; // no matches found
};

/**
 * exposed web-worker-ready "API"
 */
const OffMainThreadAPI = {
  runQuery,
  processDeveloperData
};
Comlink.expose(OffMainThreadAPI);
