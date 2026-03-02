/*
 license: The MIT License, Copyright (c) 2026 YUKI "Piro" Hiroshi
 original:
   https://github.com/piroor/webextensions-lib-cross-context-messaging
*/
'use strict';

const CrossContextMessagingContents = (() => {
  // --- Initialization based on URL ---
  const useHashBackend = new URLSearchParams(location.search).get('cross-context-messaging-backend') === 'hash';

  // --- BroadcastChannel Variables ---
  const channel = new BroadcastChannel('cross-context-messaging');
  const clientId = useHashBackend ? null : crypto.randomUUID();

  // --- HashMessaging Variables ---
  const MAX_HASH_BYTES = 6000;
  const OVERHEAD = 120;
  const incomingBuffers = new Map();
  let initPromise = null;
  const sendQueue = [];
  let isSending = false;
  let secret = null;

  // --- Shared Variables ---
  const pendingRequests = new Map();
  const messageHandlers = [];

  // --- BroadcastChannel logic ---
  if (!useHashBackend) {
    location.hash = clientId;
    channel.addEventListener('message', async (event) => {
      const data = event.data;
      if (!data) return;

      if (data.type === 'REQ_CLIENT_ID') {
        history.replaceState(null, '', '#' + clientId);
        channel.postMessage({ type: 'NOTIFY_CLIENT_ID', clientId });
        return;
      }

      if (data.targetClientId !== clientId) return;

      if (data.type === 'REQ') {
        let responded = false;

        function sendResponse(response) {
          if (responded) return;
          responded = true;
          channel.postMessage({
            senderClientId: clientId,
            id: data.id,
            type: 'RES',
            message: response
          });
        }

        for (const handler of messageHandlers) {
          const response = handler(data.message, {});
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
  }

  function sendMessageBroadcastChannel(message) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pendingRequests.set(id, resolve);
      channel.postMessage({
        senderClientId: clientId,
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

  // --- HashMessaging logic ---

  function encodeBase64(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  function decodeBase64(str) {
    str = str
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    while (str.length % 4) {
      str += '=';
    }
    return decodeURIComponent(escape(atob(str)));
  }

  function chunkString(str, size) {
    const out = [];
    for (let i = 0; i < str.length; i += size) {
      out.push(str.slice(i, i + size));
    }
    return out;
  }

  function generateId() {
    return crypto.randomUUID();
  }

  function sendRaw(payload) {
    history.replaceState(null, '', '#' + payload);
  }

  function sendChunksHash(type, id, data) {
    const base64 = encodeBase64(JSON.stringify(data));
    const chunkSize = MAX_HASH_BYTES - OVERHEAD;
    const chunks = chunkString(base64, chunkSize);
    const total = chunks.length;

    let index = 0;

    return new Promise(resolve => {
      function handleAck() {
        const h = location.hash.slice(1);
        if (h === `ACK:${secret}:${id}:${index - 1}`) {
          if (index < total) {
            sendNext();
          } else {
            window.removeEventListener('hashchange', handleAck);
            resolve();
          }
        }
      }

      function sendNext() {
        const payload =
          `MSG:${secret}:${type}:${id}:${index}/${total}:${chunks[index]}`;
        sendRaw(payload);
        index++;
      }

      window.addEventListener('hashchange', handleAck);
      sendNext();
    });
  }

  function processQueueHash() {
    if (isSending) return;
    if (sendQueue.length === 0) return;
    if (!secret) return;

    isSending = true;

    const { message, resolve, reject } = sendQueue.shift();
    const id = generateId();

    pendingRequests.set(id, result => {
      resolve(result);
      isSending = false;
      processQueueHash();
    });

    sendChunksHash('REQ', id, message);

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Timeout'));
        isSending = false;
        processQueueHash();
      }
    }, 30000);
  }

  function sendMessageHash(message) {
    return new Promise((resolve, reject) => {
      sendQueue.push({ message, resolve, reject });
      processQueueHash();
    });
  }

  function handleIncomingHash() {
    const h = location.hash.slice(1);

    if (h.startsWith('INIT:')) {
      secret = h.slice(5);
      sendRaw(`ACK-INIT:${secret}`);
      if (initPromise) {
        initPromise.resolve();
        initPromise = null;
      }
      processQueueHash();
      return;
    }

    if (!h.startsWith('MSG:')) return;

    const match = h.match(/^MSG:([^:]+):(REQ|RES):([^:]+):([^:]+):(.+)$/);
    if (!match) return;

    if (match[1] !== secret) return;

    const [, , type, id, seq, data] = match;
    const [indexStr, totalStr] = seq.split('/');
    const index = parseInt(indexStr, 10);
    const total = parseInt(totalStr, 10);

    if (!incomingBuffers.has(id)) {
      incomingBuffers.set(id, new Array(total));
    }

    const buffer = incomingBuffers.get(id);
    buffer[index] = data;

    sendRaw(`ACK:${secret}:${id}:${index}`);

    if (buffer.filter(v => v !== undefined).length === total) {
      const full = buffer.join('');
      const message = JSON.parse(decodeBase64(full));
      incomingBuffers.delete(id);

      if (type === 'REQ') {
        dispatchRequestHash(id, message);
      } else {
        const resolver = pendingRequests.get(id);
        if (resolver) {
          resolver(message);
          pendingRequests.delete(id);
        }
      }
    }
  }

  async function dispatchRequestHash(id, message) {
    let responded = false;

    function sendResponse(response) {
      if (responded) return;
      responded = true;
      sendChunksHash('RES', id, response);
    }

    for (const handler of messageHandlers) {
      const response = handler(message, {});
      if (response !== undefined) {
        sendResponse(await response);
      }
    }
  }

  if (useHashBackend) {
    window.addEventListener('hashchange', handleIncomingHash);
    handleIncomingHash();
  }

  function requestInitHash() {
    if (secret) return Promise.resolve();
    if (!initPromise) {
      let resolve;
      const promise = new Promise(r => resolve = r);
      initPromise = { promise, resolve };
      sendRaw('REQ-INIT');
    }
    return initPromise.promise;
  }

  // --- Combined Entry Points ---

  function sendMessage(message) {
    if (useHashBackend) {
      return sendMessageHash(message);
    } else {
      return sendMessageBroadcastChannel(message);
    }
  }

  function onMessage(handler) {
    messageHandlers.push(handler);
  }

  function requestInit() {
    if (useHashBackend) {
      return requestInitHash();
    } else {
      return Promise.resolve();
    }
  }

  return {
    sendMessage,
    onMessage,
    requestInit,
    get initialized() {
      if (useHashBackend) {
        return !!secret;
      }
      return true; // BroadcastChannel doesn't have an explicit wait for init locally
    },
  };
})();

export default CrossContextMessagingContents;
