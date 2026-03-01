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

  channel.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data || !data.senderClientId) return;

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

      const sender = { clientId: data.senderClientId };

      for (const handler of messageHandlers) {
        const response = handler(data.message, sender);
        if (response !== undefined) {
          sendResponse(await response);
        }
      }
    } else if (data.type === 'RES') {
      const resolver = pendingRequests.get(data.id);
      if (resolver) {
        resolver(data.message);
        pendingRequests.delete(data.id);
      }
    }
  });

  function sendMessage(clientId, message) {
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
