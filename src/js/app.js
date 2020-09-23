/* eslint-disable import/extensions */
/* eslint-disable import/no-unresolved */

import { wrap } from 'https://unpkg.com/comlink@4.3.0/dist/esm/comlink.mjs';
import {
  logr, useDOMSelector, rICQueue, rAFQueue, attrIsSupported
} from './ui-utils.js';

const uiState = {
  /**
   * how much of the device's
   * main-thread idle time should
   * we use up. Default is 75%
   */
  idleTimeUsage: 0.75,

  /**
   * how many records should the
   * app display at a given time
   */
  pageSize: 12,

  /**
   * how many developer records
   * to fetch from the server.
   * default is 3.5k
   */
  devQty: 1500,

  resetSearchResults: false,

  devsToRender: [],

  allDevsCount: 0,

  displayedFirstPage: false,

  searchDebouncer: undefined
};

let OMT;
const { info, error } = logr('App UI');
const { select } = useDOMSelector();
const progressBar = select('progress');
const contentArea = select('[data-collection-wrap]');
const countDisplay = select('[data-paginator] span');

// const iObserver = new IntersectionObserver((entries) => {
//   const srcBackup = ({ target }) => {
//     // TODO this can be a data-url if it helps to
//     // save bandwidth, latency e.t.c
//     target.src = 'https://placehold.it/48x48.png';
//   };
//   entries
//     .filter((e) => e.isIntersecting === true)
//     .forEach(({ target }) => {
//       // TODO consider un-observing the IMG elements as well
//       requestAnimationFrame(() => {
//         const img = target.querySelector('img');
//         if (img && !img.hasAttribute('src') && img.hasAttribute('data-src')) {
//           img.addEventListener('error', srcBackup);
//           img.setAttribute('src', img.getAttribute('data-src'));
//         }
//       });
//     });
// });

const renderAPage = (queue) => () => rAFQueue(...queue);

const batchDevsToRender = (state) => {
  const batchSize = 4;
  const devs = uiState.devsToRender.slice();
  const batches = devs
    .map((_, i) => (i % batchSize ? [] : devs.slice(i, i + batchSize)))
    .filter((batch) => batch.length >= 1);

  const placeholders = Array.from(contentArea.querySelectorAll('.dev-item'));
  state.batches = batches.map((devsInBatch) => () => devsInBatch.forEach((dev) => {
    if (!dev) return;

    const dom = placeholders.shift();
    if (!dom) return;

    const {
      id, avatar, bio, country
    } = dev;

    dom.setAttribute('data-dev-id', id);

    const img = dom.querySelector('img');
    img.setAttribute('data-src', avatar);
    img.setAttribute('title', bio.name);

    dom.querySelector('.about p:nth-child(1)').textContent = bio.shortName;
    dom.querySelector('.about p:nth-child(2)').textContent = `${bio.mob[0]}, ${bio.yob}`;
    dom.querySelector('.about p:nth-child(3)').textContent = country;
  }));
};

const padDevsToRenderBatches = (state) => {
  const renderChain = [
    () => {
      progressBar.classList.remove('on');

      let recordTotal = uiState.devsToRender.length;
      if (uiState.resetSearchResults) {
        recordTotal = uiState.allDevsCount;
        uiState.resetSearchResults = false;
      }
      countDisplay.textContent = `${uiState.pageSize} of ${recordTotal}`;
      const placeholders = contentArea.querySelectorAll('.dev-item');
      placeholders.forEach((pl) => pl.removeAttribute('listed'));
    },
    ...state.batches,
    () => {
      const placeholders = Array.from(contentArea.querySelectorAll('.dev-item'));
      placeholders.slice(0, uiState.pageSize + 1).forEach((pl) => pl.setAttribute('listed', ''));
      info('Displayed devs on UI!');
    }
  ];

  state.renderFn = renderAPage(renderChain);
};

const displayBatchedDevs = ({ renderFn }) => renderFn();

const scheduleRenderDevs = () => {
  info('Working on data scheduled for display ...');
  rICQueue({ state: {} }, batchDevsToRender, padDevsToRenderBatches, displayBatchedDevs);
};

const runQuery = async (query) => {
  // TODO this should be run against 
  // all valid query patterns this app
  // supports. The worker should give us
  // the patterns or say this is a valid query
  const queryFormat = /[@|#]\w+\s*[=]\s*\w+/;
  if (!queryFormat.test(query)) return;

  const matches = await OMT.runQuery(query);
  if (matches.length === 0) {
    rAFQueue(
      () => {
        const placeholders = contentArea.querySelectorAll('.dev-item');
        placeholders.forEach((pl) => pl.removeAttribute('listed'));
      },
      () => {
        progressBar.classList.remove('on');
        countDisplay.textContent = `no matches found`;
      }
    );
    return;
  }

  uiState.devsToRender = matches;
  scheduleRenderDevs();
};

let queryPromise = Promise.resolve();
const onSearchInput = ({ target }) => {
  if (uiState.searchDebouncer) clearTimeout(uiState.searchDebouncer);

  const input = (target.value || '').trim();
  if (input === '') return;

  uiState.searchDebouncer = setTimeout(() => {
    queryPromise.then(() => {
      queryPromise = runQuery(input);
      return queryPromise;
    });
  }, 1000);
};

const resetToFirstPage = async () => {
  uiState.devsToRender = await OMT.paginateTo({
    page: 0,
    pageSize: uiState.pageSize
  });
  uiState.resetSearchResults = true;
  scheduleRenderDevs();
};

const onSearchReset = async ({ target }) => {
  const input = (target.value || '').trim();
  if (input === '') {
    resetToFirstPage();
  }
};

const onSearch = async ({ target }) => {
  const input = (target.value || '').trim();
  if (input === '') {
    resetToFirstPage();
    return
  }

  runQuery(input);
};

const enableSmartSearch = () => {
  info('Enabling smart search ...');
  const searchField = select('input');

  const hasIncrementalSearch = attrIsSupported({
    attr: 'incremental',
    element: searchField
  });
  
  if (hasIncrementalSearch) {
    searchField.addEventListener('search', onSearch);
  } else {
    searchField.addEventListener('input', onSearchInput);
    searchField.addEventListener('search', onSearchReset);
    searchField.addEventListener('keyup', onSearchReset);
  }

  let tourId;
  let tourIndex = 0;
  const tour = ['', 'make your move ...', 'start by typing @ or #', 'so much is possible', ''];
  const getNextTourStep = () => {
    const step = tour[tourIndex];
    tourIndex = (tourIndex + 1) % tour.length;
    return step;
  };

  const endTourOnClick = () => {
    requestIdleCallback(() => {
      if (tourId) {
        tourIndex = 0;
        requestAnimationFrame(() => {
          searchField.setAttribute('placeholder', '');
        });
        clearInterval(tourId);
      }
    });
  };
  searchField.addEventListener('click', endTourOnClick);

  tourId = setInterval(() => {
    requestAnimationFrame(() => {
      const step = getNextTourStep();
      searchField.setAttribute('placeholder', `${step}`);
    });
  }, 3000);

  info('Smart search is ready to take queries');
};

const handleFecthResponse = async ([data]) => {
  const { developers } = data;
  progressBar.value = developers.length;
  info(`Received ${developers.length} dev records ...`);

  if (!uiState.displayedFirstPage) {
    info('Working on page 1 of all records ...');
    const payload = { developers, isFirstPage: true, pageSize: uiState.pageSize };
    const { devsToRender } = await OMT.processDeveloperData(payload);

    progressBar.value = devsToRender.length;
    uiState.devsToRender = devsToRender;
    uiState.allDevsCount += devsToRender.length;

    requestAnimationFrame(() => {
      select('[data-search-wrap] input').setAttribute('placeholder', '');
      select('body').classList.add('ready');
    });
    scheduleRenderDevs();
    enableSmartSearch();
    uiState.displayedFirstPage = true;
  }

  info('There\'s more data, lets process the rest in the background');
  const { devsCount } = await OMT.processDeveloperData();
  uiState.allDevsCount = devsCount;
  requestAnimationFrame(() => {
    countDisplay.textContent = `${uiState.pageSize} of ${uiState.allDevsCount}`;
  });
};

const fetchData = async () => {
  const APIBase = 'https://randomapi.com/api/3qjlr7d4';
  const APIKey = 'LEIX-GF3O-AG7I-6J84';

  // TODO expose devQty from the UI
  const endpoint = `${APIBase}?key=${APIKey}&qty=${uiState.devQty}`;

  // TODO when we upgrade to streams, communicate
  // fetch progress with the progress bar
  return fetch(endpoint)
    .then((response) => response.json())
    .then(({ results }) => handleFecthResponse(results))
    .catch((err) => error(err));
};

const startApp = async () => {
  progressBar.setAttribute('max', uiState.devQty);

  const worker = new Worker('./js/off-main-thread/omt.js');
  OMT = wrap(worker);

  info(`Fetching devs data ...`);
  fetchData();
};

document.addEventListener('DOMContentLoaded', startApp);
