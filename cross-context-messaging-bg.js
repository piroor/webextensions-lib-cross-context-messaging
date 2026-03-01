/*
 license: The MIT License, Copyright (c) 2026 YUKI 'Piro' Hiroshi
 original:
   https://github.com/piroor/webextensions-lib-cross-context-messaging
*/
'use strict';

const CrossContextMessagingBG = (() => {
  const channel = new BroadcastChannel('cross-context-messaging');
  const pendingRequests = new Map();
  const messageHandlers = [];

  const tabIdToClientId = new Map();
  const clientIdToTabId = new Map();
  const urlHashCheckRegExp = /^#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

  function checkUrlForClientId(tabId, urlString, windowId) {
    try {
      const url = new URL(urlString);
      const match = url.hash.match(urlHashCheckRegExp);
      if (match) {
        const clientId = match[1];
        const oldData = tabIdToClientId.get(tabId);
        if (oldData) {
          clientIdToTabId.delete(oldData.clientId);
        }
        tabIdToClientId.set(tabId, { clientId, windowId });
        clientIdToTabId.set(clientId, tabId);
      }
    } catch (e) {
    }
  }

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      checkUrlForClientId(tabId, changeInfo.url, tab.windowId);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    const data = tabIdToClientId.get(tabId);
    if (data) {
      clientIdToTabId.delete(data.clientId);
    }
    tabIdToClientId.delete(tabId);
  });
  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    const data = tabIdToClientId.get(tabId);
    if (data) {
      data.windowId = attachInfo.newWindowId;
    }
  });
  chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    const data = tabIdToClientId.get(tabId);
    if (data && data.windowId === detachInfo.oldWindowId) {
      data.windowId = null;
    }
  });
  chrome.windows.onRemoved.addListener((windowId) => {
    for (const [tabId, data] of tabIdToClientId.entries()) {
      if (data.windowId === windowId) {
        clientIdToTabId.delete(data.clientId);
        tabIdToClientId.delete(tabId);
      }
    }
  });

  channel.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'NOTIFY_CLIENT_ID' && data.clientId) {
      chrome.tabs.query({}, (tabs) => {
        if (!tabs) return;
        for (const tab of tabs) {
          if (tab.url) {
            try {
              const url = new URL(tab.url);
              if (url.hash === '#' + data.clientId) {
                const oldData = tabIdToClientId.get(tab.id);
                if (oldData) {
                  clientIdToTabId.delete(oldData.clientId);
                }
                tabIdToClientId.set(tab.id, { clientId: data.clientId, windowId: tab.windowId });
                clientIdToTabId.set(data.clientId, tab.id);
              }
            } catch (e) {
            }
          }
        }
      });
      return;
    }

    if (!data.senderClientId) return;

    if (data.type === 'REQ') {
      let responded = false;

      function sendResponse(response) {
        if (responded) return;
        responded = true;
        channel.postMessage({
          targetClientId: data.senderClientId,
          id: data.id,
          type: 'RES',
          message: response
        });
      }

      const tabId = clientIdToTabId.get(data.senderClientId);
      const processMessage = async (tab) => {
        const sender = { tab };
        for (const handler of messageHandlers) {
          const response = handler(data.message, sender);
          if (response !== undefined) {
            sendResponse(await response);
          }
        }
      };

      if (tabId !== undefined) {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) {
            processMessage(undefined);
          } else {
            processMessage(tab);
          }
        });
      } else {
        processMessage(undefined);
      }
    } else if (data.type === 'RES') {
      const resolver = pendingRequests.get(data.id);
      if (resolver) {
        resolver(data.message);
        pendingRequests.delete(data.id);
      }
    }
  });

  async function sendMessage(tabId, message) {
    let clientData = tabIdToClientId.get(tabId);
    let clientId = clientData ? clientData.clientId : undefined;

    if (!clientId) {
      channel.postMessage({ type: 'REQ_CLIENT_ID' });

      let attempts = 0;
      while (!tabIdToClientId.has(tabId) && attempts < 20) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }

      clientData = tabIdToClientId.get(tabId);
      clientId = clientData ? clientData.clientId : undefined;
      if (!clientId) {
        throw new Error(`Failed to send message: there is no client for the tab ${tabId}`);
      }
    }

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pendingRequests.set(id, resolve);
      channel.postMessage({
        targetClientId: clientId,
        id,
        type: 'REQ',
        message
      });

      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Timeout'));
        }
      }, 30000);
    });
  }

  function onMessage(handler) {
    messageHandlers.push(handler);
  }

  return { sendMessage, onMessage };
})();

export default CrossContextMessagingBG;
