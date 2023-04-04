function generateOffsets(startOffset, total) {
  let interval = 20;
  let start = startOffset + interval;
  let offsets = [];

  for (let i = start; i <= total; i += interval) {
    offsets.push(i);
  }

  return offsets;
}

function sleep(ms = 1000) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}

function parseConversation(rawConversation) {
  const title = rawConversation.title;
  const conversationCreatedTimestamp = rawConversation.created_time;
  const mapping = rawConversation.mapping;
  const keys = Object.keys(mapping);
  const messages = [];

  for (const k of keys) {
    const msgPayload = mapping[k];
    const msg = msgPayload.message;
    if (!msg) continue;

    const role = msg.author.role;
    const content = msg.content.parts;
    const model = msg.metadata.model_slug;
    const msgCreatedTimestamp = msg.create_time;

    messages.push({
      role,
      content,
      model,
      msgCreatedTimestamp,
    });
  }

  return {
    messages,
    conversationCreatedTimestamp,
    title,
  };
}

function getRequestCount(total, startOffset, stopOffset) {
  if (stopOffset === -1) return total;

  return stopOffset - startOffset;
}

function logProgress(total, messages, offset) {
  const progress = Math.round((messages / total) * 100);
  console.log(`GPT-BACKUP::PROGRESS::${progress}%::OFFSET::${offset}`);
}

function getDateFormat(date) {
  const year = date.getFullYear();
  const month = ('0' + (date.getMonth() + 1)).slice(-2);
  const day = ('0' + date.getDate()).slice(-2);
  const hours = ('0' + date.getHours()).slice(-2);
  const minutes = ('0' + date.getMinutes()).slice(-2);
  const seconds = ('0' + date.getSeconds()).slice(-2);

  return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

function downloadJson(data) {
  const jsonString = JSON.stringify(data, null, 2);
  const jsonBlob = new Blob([jsonString], { type: 'application/json' });
  const downloadLink = document.createElement('a');
  downloadLink.href = URL.createObjectURL(jsonBlob);
  downloadLink.download = `gpt-backup-${getDateFormat(new Date())}.json`;
  document.body.appendChild(downloadLink);
  downloadLink.click();

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      document.body.removeChild(downloadLink);
      URL.revokeObjectURL(downloadLink.href);
      resolve();
    }, 150);
  });
}

async function loadToken() {
  const res = await fetch('https://chat.openai.com/api/auth/session');

  if (!res.ok) {
    throw new Error('failed to fetch token');
  }

  const json = await res.json();
  return json.accessToken;
}

async function getConversationIds(token, offset = 0) {
  const res = await fetch(
    `https://chat.openai.com/backend-api/conversations?offset=${offset}&limit=20`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );

  if (!res.ok) {
    throw new Error('failed to fetch conversation ids');
  }

  const json = await res.json();
  return {
    items: json.items.map((item) => ({ ...item, offset })),
    total: json.total,
  };
}

async function fetchConversation(token, id, maxAttempts = 3, attempt = 1) {
  const res = await fetch(
    `https://chat.openai.com/backend-api/conversation/${id}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );

  if (!res.ok) {
    const exceeded = attempt >= maxAttempts;
    if (res.status === 429 && !exceeded) {
      await sleep(30000);
      return fetchConversation(token, id, maxAttempts, attempt + 1);
    } else {
      throw new Error('failed to fetch conversation');
    }
  }

  return res.json();
}

async function getAllConversations(startOffset, stopOffset) {
  const token = await loadToken();

  // get first batch
  const { total, items: allItems } = await getConversationIds(
    token,
    startOffset,
  );

  // generate offsets
  const offsets = generateOffsets(startOffset, total);

  console.log(offsets);
  // don't spam api
  // fetch all offsets
  for (const offset of offsets) {
    // stop at offset
    if (offset === stopOffset) break;

    await sleep();

    const { items } = await getConversationIds(token, offset);
    allItems.push.apply(allItems, items);
  }

  const allConversations = [];
  const requested = getRequestCount(total, startOffset, stopOffset);
  for (const item of allItems) {
    // 60msg/min
    await sleep(1000);

    const rawConversation = await fetchConversation(token, item.id);
    const conversation = parseConversation(rawConversation);
    allConversations.push(conversation);

    if (allConversations.length % 20 === 0) {
      logProgress(requested, item.offset, allConversations.length);
    }
  }

  const lastOffset =
    stopOffset === -1 ? offsets[offsets.length - 1] : stopOffset;
  logProgress(requested, allConversations.length, lastOffset);

  return allConversations;
}

async function main(startOffset, stopOffset) {
  const allConversations = await getAllConversations(startOffset, stopOffset);
  await downloadJson(allConversations);
}

// customize if you need to continue from a previous run
// increments of 20
const START_OFFSET = 0;
// set to -1 to run through all messages
const STOP_OFFSET = -1;

main(START_OFFSET, STOP_OFFSET)
  .then(() => console.log('GPT-BACKUP::DONE'))
  .catch((e) => console.error(e));