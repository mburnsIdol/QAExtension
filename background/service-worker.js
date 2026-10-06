/* ==========================================================================
   Mattccessibility Tool — Background Service Worker (Manifest V3)
   1. Side panel opens on toolbar click
   2. DNR rule strips frame-blocking headers on sub_frame responses so the
      in-page mobile simulator iframe can render any site
   3. Message handlers: NAVIGATE_AND_WAIT, OPEN_DEVICE_WINDOW, RESIZE_WINDOW_TO_DEVICE
   ========================================================================== */

const FRAME_UNBLOCK_RULE_ID = 2001;
const NAVIGATION_TIMEOUT_MS = 20000;

const STRIPPED_FRAME_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy'
];

/* --------------------------------------------------------------------------
   1. Side panel
   -------------------------------------------------------------------------- */
function setupSidePanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[Mattccessibility] setPanelBehavior failed:', err));
}

/* --------------------------------------------------------------------------
   2. Declarative Net Request — sub-frame header unblocking
   -------------------------------------------------------------------------- */
async function setupDeclarativeNetRequestRules() {
  if (!chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [FRAME_UNBLOCK_RULE_ID],
      addRules: [
        {
          id: FRAME_UNBLOCK_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: STRIPPED_FRAME_HEADERS.map((header) => ({ header, operation: 'remove' }))
          },
          condition: { resourceTypes: ['sub_frame'] }
        }
      ]
    });
  } catch (err) {
    console.warn('[Mattccessibility] DNR rule setup failed:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupSidePanel();
  setupDeclarativeNetRequestRules();
});

chrome.runtime.onStartup.addListener(() => {
  setupSidePanel();
  setupDeclarativeNetRequestRules();
});

// Service workers can be restarted without onStartup firing; re-assert on load.
setupSidePanel();
setupDeclarativeNetRequestRules();

/* --------------------------------------------------------------------------
   3. Message handlers
   -------------------------------------------------------------------------- */
function navigateAndWait(tabId, url) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(result);
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish({ ok: true });
      }
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `The page took longer than ${NAVIGATION_TIMEOUT_MS / 1000}s to load.` });
    }, NAVIGATION_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch((err) => {
      finish({ ok: false, error: err && err.message ? err.message : String(err) });
    });
  });
}

async function openDeviceWindow(url, width, height) {
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    width: Math.round(width),
    height: Math.round(height),
    focused: true
  });
  return { ok: true, windowId: win.id };
}

async function resizeWindowToDevice(windowId, width, height) {
  const targetId = typeof windowId === 'number' ? windowId : (await chrome.windows.getCurrent()).id;
  await chrome.windows.update(targetId, {
    state: 'normal',
    width: Math.round(width),
    height: Math.round(height)
  });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  const respond = (promise) => {
    Promise.resolve(promise)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true; // keep the channel open for the async response
  };

  switch (message.type) {
    case 'NAVIGATE_AND_WAIT':
      return respond(navigateAndWait(message.tabId, message.url));
    case 'OPEN_DEVICE_WINDOW':
      return respond(openDeviceWindow(message.url, message.width, message.height));
    case 'RESIZE_WINDOW_TO_DEVICE':
      return respond(resizeWindowToDevice(message.windowId, message.width, message.height));
    default:
      return false;
  }
});
