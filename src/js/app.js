/* Some Ideas ==========+
  1. Demostrate impact of data-saver mode, as well as when user is on slow (2G) connections

  2. If posible, demonstrate processing on ui-thread and then with comlink/web-worker.
     E.g allow the user toggle between these options with a radio button

  3. Consider paginating the records with a sort of re-cycler view and only load images just before
  they are needed

  4. Consider using components for the UI elements and don't allow their
     internal implementation details to leak out. Wrap such with a clean API
    e.g Do pBar.turnOn(); pBar.progressTo(50) or pBar.turnOn().progressTo(50)
    instead of pBar.classList.remove('off')

  5. If it makes sense, use HTTP streams so that we dont have to wait to
     fetch all the data before displaying anything. Can be
     very poor UX on slow connections, even if not displaying any images

  6. Make the logs viewable as part of the app and make the output very beautiful

  7. Make this into a PWA, if it makes sense
*/

/* eslint-disable import/extensions */
/* eslint-disable import/no-unresolved */

import { wrap } from 'https://unpkg.com/comlink@4.3.0/dist/esm/comlink.mjs';
// import { wrap } from 'comlink';

// import OMT from './off-main-thread/omt.js';
import { log, useDOMSelector, getDomParser } from './ui-utils.js';

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

  devsToRender: [],

  allDevsCount: 0,

  displayedFirstPage: false,

  searchDebouncer: undefined
};

let OMT;
const domParser = getDomParser();
const { select } = useDOMSelector();
const progressBar = select('progress');
const contentArea = select('[data-collection-wrap]');
// const ageDisplay = select('[data-search-wrap] span:nth-child(2)');
const countDisplay = select('[data-search-wrap] span:nth-child(1)');

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

// const timeIsRemaining = (deadline) => {
//   if (deadline && typeof deadline.timeRemaining === 'function') {
//     // TODO if possible, expose what 0.75 represents to the UI and allow the user to control it
//     return parseInt(deadline.timeRemaining() * uiState.idleTimeUsage, 10) > 0;
//   }
//   return false;
// };

const renderAPage = () => {
  const items = uiState.devsToRender.slice();
  const nodes = domParser().parseFromString(items.join(''), 'text/html');
  contentArea.innerHTML = '';
  nodes.body.childNodes.forEach((node) => {
    contentArea.appendChild(node);
    // iObserver.observe(n);
  });

  progressBar.classList.remove('on');
  countDisplay.textContent = `${uiState.devsToRender.length} of ${uiState.allDevsCount}`;
};

const runQuery = async (query) => {
  uiState.devsToRender = await OMT.runQuery(query);
  requestIdleCallback(renderAPage);
};

let queryPromise = Promise.resolve();
const onSearchInput = ({ target }) => {
  if (uiState.searchDebouncer) clearTimeout(uiState.searchDebouncer);

  const input = (target.value || '').trim();
  if (input === '') return;

  const queryFormat = /[@|#]\w+\s*[=]\s*\w+/;
  if (!queryFormat.test(input)) return;

  uiState.searchDebouncer = setTimeout(() => {
    queryPromise.then(() => {
      queryPromise = runQuery(input);
      return queryPromise;
    });
  }, 1000);
};

const enableSmartSearch = () => {
  const searchField = select('input');
  searchField.addEventListener('input', onSearchInput);
  searchField.focus();

  let tourId;
  let tourIndex = 0;
  const tour = [
    '',
    'make your move ...',
    'start by typing @ or #',
    'there\'s so much you can do',
    ''
  ];

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
      searchField.setAttribute('placeholder', tour[tourIndex]);
      tourIndex = (tourIndex + 1) % tour.length;
    });
  }, 3000);
};

const handleFecthResponse = async ([data]) => {
  const { developers } = data;
  progressBar.value = developers.length;
  log(`Received ${developers.length} devs data ...`);

  if (!uiState.displayedFirstPage) {
    const payload = { developers, isFirstPage: true, pageSize: uiState.pageSize };
    const { devsToRender } = await OMT.processDeveloperData(payload);

    progressBar.value = devsToRender.length;
    uiState.devsToRender = devsToRender;
    uiState.allDevsCount += devsToRender.length;

    requestAnimationFrame(() => {
      select('body').classList.add('ready');
      requestAnimationFrame(renderAPage);
    });
    enableSmartSearch();
    uiState.displayedFirstPage = true;
  }

  const { devsCount } = await OMT.processDeveloperData();
  uiState.allDevsCount += (devsCount - uiState.pageSize);
  requestAnimationFrame(() => {
    countDisplay.textContent = `${uiState.devsToRender.length} of ${uiState.allDevsCount}`;
  });
};

const fetchData = async () => {
  const APIBase = 'https://randomapi.com/api/3qjlr7d4';
  const APIKey = 'LEIX-GF3O-AG7I-6J84';

  // TODO expose devQty from the UI
  const endpoint = `${APIBase}?key=${APIKey}&qty=${uiState.devQty}`;

  progressBar.setAttribute('max', uiState.devQty);
  progressBar.classList.add('on');

  // TODO when we upgrade to streams, communicate
  // fetch progress with the progress bar
  return fetch(endpoint)
    .then((response) => response.json())
    .then(({ results }) => handleFecthResponse(results))
    .catch((error) => log(error));
};

const startApp = async () => {
  const worker = new Worker('./js/off-main-thread/omt.js');
  OMT = wrap(worker);
  fetchData();
};

document.addEventListener('DOMContentLoaded', startApp);
