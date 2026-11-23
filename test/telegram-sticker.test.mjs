import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createChannels } from '../lib/channels.mjs';
import { createConnector } from '../lib/channels/telegram.mjs';
import { fetchStaticSticker, MAX_STICKER_BYTES } from '../lib/channels/telegram-sticker.mjs';

// Synthetic 32x32 drawings (yellow face, black eyes, smile or frown), not Telegram media.
const smile = Buffer.from('UklGRn4AAABXRUJQVlA4THIAAAAvH8AHEBcw1fM/RfMfgAdHkW070am3fFLwAxMkoOKbmLjK6dgkoyCi/xPAnNpz0+yoAqUTcOsk/DoV2DuieNWPUWz0YNz68uZVP53eVbz1ahYP2hjFox4N3P/bt2Bb13/hZ3OwgptqQukE0AG4aXZQ5gQ=', 'base64');
const frown = Buffer.from('UklGRn4AAABXRUJQVlA4THIAAAAvH8AHEBcw1fM/RfMfgAdHkW070am3fFLwAxMkoOKbmLjK6dgkoyCi/xPAnNpz0+yoAqUTcOsk/DoV2DuieNWPUWz0YNz68uZVP53edTQHzWJb13+juP+3bwMbPQge9Sj83rqv4KaaUDoBdABumh2UOQE=', 'base64');
const annotation = { mood: 'A yellow face with an upward-curved smile', tags: ['happy', 'warm'], text: '' };
const reviewed = new Map([['8ac030dd55c4f5d1f0cf6433fe39bb40dba6f51c6ac5c641b34ff57db70a82d6', annotation]]);
const msg = (message_id, extra = {}) => ({ message_id, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Synthetic' }, ...extra });
const sticker = (file_id, extra = {}) => ({ file_id, is_animated: false, is_video: false, emoji: 'MISLEADING_EMOJI', set_name: 'MISLEADING_SET', ...extra });

const pair = (id, chatId = id) => ({ id: String(id), chatId: String(chatId), name: 'Synthetic' });
const dm = (id) => ({ chat: { id, type: 'private' }, from: { id, first_name: 'Synthetic' } });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate, description) {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), description);
}

async function telegramFixture(t, { messages, paired = [pair(42)], viaTicket = false, beforeGetFile, stickerSettled, newTopic, release }) {
  const root = await mkdtemp(join(tmpdir(), 'native-sticker-fixture-'));
  const file = join(root, 'channels.json');
  const feed = deferred();
  const offered = deferred();
  let channels;
  t.after(async () => {
    release?.();
    feed.resolve();
    try {
      await channels?.stopAll();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await writeFile(file, JSON.stringify({ channels: { 'bot/app': { paired } } }));
  const owner = { id: 'bot', handle: 'fixture', name: 'Fixture', role: viaTicket ? 'router' : 'bot', apps: [{ id: 'app', template: 'telegram', values: { token: 'fixture-token' } }] };
  let poll = 0;
  const gets = [];
  const downloads = [];
  const unexpected = [];
  const seen = [];
  const admitted = [];
  const result = (value) => Response.json({ ok: true, result: value });
  const fetchImpl = async (url, init) => {
    const prefix = 'https://telegram.invalid/';
    if (!url.startsWith(prefix)) {
      unexpected.push(url);
      throw new Error(`unexpected fixture URL: ${url}`);
    }
    const path = url.slice(prefix.length);
    if (path === 'botfixture-token/getMe') return result({ id: 100, username: 'fixture' });
    if (path === 'botfixture-token/getUpdates') {
      if (JSON.parse(init.body).limit === 1) return result([]); // in-memory stop acknowledgement
      if (++poll === 1) {
        await feed.promise;
        return result(messages.map((message, index) => ({ update_id: index + 1, message })));
      }
      offered.resolve(); // The real connector has offered the entire batch to the channel.
      return new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
    if (path === 'botfixture-token/getFile') {
      const id = JSON.parse(init.body).file_id;
      gets.push(id);
      if (init.redirect !== 'error') unexpected.push(`${id}: getFile must reject redirects`);
      await beforeGetFile?.(id, init.signal);
      return result({ file_path: `stickers/${id}.webp` });
    }
    if (path.startsWith('file/botfixture-token/stickers/')) {
      const id = path.split('/').at(-1);
      downloads.push(id);
      if (init.redirect !== 'error') unexpected.push(`${id}: file GET must reject redirects`);
      return new Response(id === 'smile.webp' ? smile : frown);
    }
    unexpected.push(path);
    throw new Error(`unexpected fixture method: ${path}`);
  };
  const capture = (route, payload, meta) => { seen.push({ route, payload, meta }); };
  channels = createChannels({
    file, bots: () => [owner], entries: () => [{ id: 'telegram', kind: 'channel', fields: [{ key: 'token', kind: 'secret' }] }],
    loadConnector: async () => ({ createConnector: (opts) => createConnector({
      ...opts, apiBase: 'https://telegram.invalid', fetchImpl,
      onMessage: (message) => {
        if (stickerSettled && message.loadSticker) {
          const load = message.loadSticker;
          message = { ...message, loadSticker: async (...args) => {
            try {
              return await load(...args);
            } finally {
              stickerSettled.resolve();
            }
          } };
        }
        opts.onMessage(message);
      },
    }) }),
    // Whole-chat threads go to a ticket only while exactly one ticket awaits an answer.
    subscribers: (key) => viaTicket ? [{ id: 'ticket', botId: 'worker', startedAt: 1, threads: [key], reports: [{ status: 'question', at: 1 }] }] : [],
    admitSticker: async (image) => { admitted.push(image); return { attachmentId: `fixture-${admitted.length}` }; },
    reviewedStickerAnnotations: reviewed,
    deliver: async (_owner, payload, meta) => capture('home', payload, meta),
    toTickets: async (_list, payload, meta) => { capture('ticket', payload, meta); return []; },
    newTopic,
  });
  channels.sync();
  await waitUntil(() => channels._live.get('bot/app')?.account?.id === '100', 'fake Telegram account did not connect');
  feed.resolve();
  await offered.promise;
  return { channels, gets, downloads, unexpected, seen, admitted };
}

for (const viaTicket of [false, true]) test(`native DM semantic payload via ${viaTicket ? 'ticket' : 'home'}`, { timeout: 5000 }, async (t) => {
  const messages = [
    msg(1, { text: 'ordinary text' }), msg(2, { photo: [{ file_id: 'old_photo' }] }),
    msg(3, { chat: { id: -17, type: 'group' }, sticker: sticker('group') }),
    msg(4, { ...dm(43), sticker: sticker('unpaired') }),
    msg(5, { chat: { id: 43, type: 'private' }, sticker: sticker('wrong_chat') }),
    msg(6, { from: { id: 42, is_bot: true }, sticker: sticker('bot_sender') }),
    msg(7, { sticker: sticker('animated', { is_animated: true }) }),
    msg(8, { sticker: sticker('video', { is_video: true }) }),
    msg(9, { sticker: sticker('smile') }), msg(9, { sticker: sticker('duplicate') }),
    msg(10, { sticker: sticker('frown'), forward_origin: { type: 'hidden_user', date: 1700000000, sender_user_name: 'Unpaired synthetic original author' } }),
    msg(11, { text: 'forwarded plain text', forward_origin: { type: 'hidden_user', date: 1700000000, sender_user_name: 'Unpaired synthetic original author' } }),
    msg(12, { ...dm(44), sticker: sticker('forwarded_unpaired'), forward_origin: { type: 'user', date: 1700000000, sender_user: { id: 42, is_bot: false, first_name: 'Synthetic' } } }),
    msg(13, { photo: [{ file_id: 'forwarded_photo' }], forward_origin: { type: 'hidden_user', date: 1700000000, sender_user_name: 'Synthetic author' } }),
    msg(14, { photo: [{ file_id: 'album_first' }], media_group_id: 'synthetic_album', caption: 'Album caption https://example.invalid/' }),
    msg(15, { photo: [{ file_id: 'album_second' }], media_group_id: 'synthetic_album' }),
    msg(16, { text: 'text after unsupported photos' }),
  ];
  const { gets, downloads, unexpected, seen, admitted } = await telegramFixture(t, { messages, viaTicket });
  await waitUntil(() => seen.some(({ meta }) => meta.origin.messageId === '16'), 'same-chat text after media did not arrive');
  await nextTurn();
  assert.deepEqual(gets, ['smile', 'frown']);
  assert.deepEqual(downloads, ['smile.webp', 'frown.webp']);
  assert.deepEqual(unexpected, []);
  // Photo-only, forwarded photo and captioned media groups are intentionally outside this patch.
  assert.deepEqual(seen.map(({ meta }) => meta.origin.messageId), ['1', '9', '10', '11', '16']);
  assert.ok(seen.every(({ route }) => route === (viaTicket ? 'ticket' : 'home')));
  const byId = (id) => seen.find(({ meta }) => meta.origin.messageId === String(id));
  assert.equal(byId(1).payload.body, 'ordinary text');
  assert.equal(byId(1).payload.refs, undefined);
  assert.equal(byId(1).payload.context, undefined);
  assert.equal(byId(11).payload.body, 'forwarded plain text');
  assert.equal(byId(11).payload.refs, undefined);
  assert.equal(byId(11).payload.context, undefined);
  const known = byId(9);
  assert.match(known.payload.context, /upward-curved smile/);
  assert.match(known.payload.context, /happy/);
  assert.equal(known.meta.origin.context, known.payload.context);
  assert.equal(known.payload.refs.length, 1);
  assert.equal(byId(10).payload.refs.length, 1);
  assert.match(byId(10).payload.context, /interpret the attached sticker image in the context/i);
  assert.match(byId(10).payload.context, /unclear, treat it as unknown rather than guessing/i);
  assert.doesNotMatch(byId(10).payload.context, /happy|warm|reviewed sticker annotation/i);
  assert.doesNotMatch(JSON.stringify(seen), /MISLEADING/);
  assert.deepEqual(admitted.map(({ mediaType }) => mediaType), ['image/webp', 'image/webp']);
  assert.deepEqual(admitted.map(({ data }) => data).sort(), [smile.toString('base64'), frown.toString('base64')].sort());
});

test('unpairing during getFile prevents a file GET even when the lookup ignores abort', { timeout: 5000 }, async (t) => {
  const getFileEntered = deferred();
  const releaseGetFile = deferred();
  const stickerSettled = deferred();
  const { channels, gets, downloads, unexpected, seen, admitted } = await telegramFixture(t, {
    messages: [msg(1, { sticker: sticker('revoked') })],
    beforeGetFile: async (_id, signal) => {
      getFileEntered.resolve(signal);
      await releaseGetFile.promise; // Deliberately ignore abort and return a successful getFile response.
    },
    stickerSettled,
    release: releaseGetFile.resolve,
  });
  const signal = await getFileEntered.promise;
  assert.equal(signal.aborted, false);
  assert.equal(channels.unpair('bot', 'app', '42'), true);
  releaseGetFile.resolve();
  await stickerSettled.promise; // The real loader settled while the connector was still up.
  await nextTurn();
  assert.deepEqual(gets, ['revoked']);
  assert.deepEqual(downloads, []);
  assert.equal(signal.aborted, true);
  assert.deepEqual(admitted, []);
  assert.deepEqual(seen, []);
  assert.deepEqual(unexpected, []);
});

test('matching Telegram sender and chat do not override a different paired chatId', { timeout: 5000 }, async (t) => {
  const { gets, downloads, unexpected, seen, admitted } = await telegramFixture(t, {
    paired: [pair(42, 142)],
    messages: [msg(1, { sticker: sticker('wrong_pair') }), msg(2, { text: 'positive text control' })],
  });
  await waitUntil(() => seen.some(({ meta }) => meta.origin.messageId === '2'), 'same-chat text control did not arrive');
  await nextTurn();
  assert.deepEqual(gets, []);
  assert.deepEqual(downloads, []);
  assert.deepEqual(admitted, []);
  assert.deepEqual(seen.map(({ meta }) => meta.origin.messageId), ['2']);
  assert.deepEqual(unexpected, []);
});

for (const transientFailure of [false, true]) test(`slow sticker ${transientFailure ? 'failure releases its own chat' : 'preserves DM order including /new'}`, { timeout: 5000 }, async (t) => {
  const getFileEntered = deferred();
  const releaseGetFile = deferred();
  const order = [];
  const { gets, downloads, unexpected, seen, admitted } = await telegramFixture(t, {
    paired: [pair(42), pair(43)],
    messages: [
      msg(1, { sticker: sticker('smile') }),
      msg(2, { text: 'same-chat text' }),
      ...(!transientFailure ? [msg(3, { text: '/new next topic text' })] : []),
      msg(1, { ...dm(43), text: 'other-chat text' }),
    ],
    beforeGetFile: async () => {
      getFileEntered.resolve();
      await releaseGetFile.promise;
      if (transientFailure) throw new Error('fixture transient getFile failure');
    },
    newTopic: async () => { order.push(seen.map(({ meta }) => `${meta.origin.chatId}:${meta.origin.messageId}`)); },
    release: releaseGetFile.resolve,
  });
  const ids = () => seen.map(({ meta }) => `${meta.origin.chatId}:${meta.origin.messageId}`);
  await getFileEntered.promise;
  await waitUntil(() => ids().includes('43:1'), 'the other DM was blocked by the slow sticker');
  await nextTurn();
  assert.deepEqual(ids(), ['43:1']);
  assert.deepEqual(order, []);
  assert.deepEqual(admitted, []);
  releaseGetFile.resolve();
  const expected = transientFailure ? ['43:1', '42:2'] : ['43:1', '42:1', '42:2', '42:3'];
  await waitUntil(() => seen.length >= expected.length, 'the slow sticker blocked or reordered subsequent DM submissions');
  await nextTurn();
  assert.deepEqual(ids(), expected);
  assert.deepEqual(gets, transientFailure ? ['smile', 'smile'] : ['smile']);
  assert.deepEqual(downloads, transientFailure ? [] : ['smile.webp']);
  assert.equal(admitted.length, transientFailure ? 0 : 1);
  assert.deepEqual(order, transientFailure ? [] : [['43:1', '42:1', '42:2']]);
  assert.deepEqual(seen.map(({ payload }) => payload.body), transientFailure
    ? ['other-chat text', 'same-chat text']
    : ['other-chat text', '[Telegram static sticker]', 'same-chat text', 'next topic text']);
  assert.deepEqual(unexpected, []);
});

async function hostFixture(t, { beforeResolve, readHistory, release, paired = [pair(42)] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-sticker-host-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  let host;
  t.after(async () => {
    release?.();
    try {
      await host?.channels.stopAll();
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = oldHome;
      await rm(root, { recursive: true, force: true });
    }
  });
  const { apply } = await import('../index.js');
  const dir = join(root, 'cache', 'bots');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'bots.json'), JSON.stringify({ version: 0, bots: [{ id: 'fixture-bot', name: 'Fixture' }] }));
  await writeFile(join(dir, 'channels.json'), JSON.stringify({ channels: {
    'fixture-bot/app': { paired, account: { id: '100' } },
  } }));

  const configuredModel = { provider: 'fixture-provider', model: 'fixture-existing-vision' };
  const modelSelections = [];
  const modelRequests = [];
  const submitted = [];
  const attachmentBytes = new Map();
  const agents = new Map();
  const failures = [];
  let offer;
  let selected = { provider: 'fixture-default', model: 'fixture-default-model' };
  const modelStream = (request) => { modelRequests.push(request); };
  const history = [];
  const projectToModel = (message, ...overrides) => {
    assert.deepEqual(overrides, []);
    assert.equal(message.role, 'user');
    const content = message.content.map((block) => {
      if (block.type !== 'image') return block;
      const version = attachmentBytes.get(block.attachment.attachmentId);
      assert.ok(version);
      return { type: 'image', mimeType: version.mediaType, data: version.data.toString('base64') };
    });
    history.push({ role: message.role, content });
    modelStream({ ...selected, messages: [...history] });
  };
  const services = {
    agents,
    sessionController: {
      create: async ({ sessionId }) => {
        agents.set(sessionId, {
          session: { id: sessionId },
          status: 'idle',
          model: { select: (value) => { modelSelections.push(value); selected = value; } },
          followup: (message) => { submitted.push(message); projectToModel(message); },
        });
        return { sessionId };
      },
      resolveAgent: async (sessionId) => {
        await beforeResolve?.(sessionId);
        return { agent: agents.get(sessionId) };
      },
    },
    attachments: {
      admitPromptContent: async (parts) => parts.map((part) => {
        assert.equal(part.type, 'image');
        const data = Buffer.from(part.data, 'base64');
        const attachmentId = `fixture-image-${attachmentBytes.size + 1}`;
        attachmentBytes.set(attachmentId, { mediaType: part.mediaType, data });
        return { type: 'image', attachment: { attachmentId, mediaType: part.mediaType, bytes: data.length, width: 32, height: 32 } };
      }),
    },
  };
  host = apply({
    get: (name) => services[name], effect: () => {}, on: () => {},
    logger: { info: (text) => { if (/telegram message:|could not be attached|could not hand/.test(text)) failures.push(text); } },
  }, {}, {
    home: root, prices: false, sweep: false, history: readHistory,
    loadConnector: async (kind) => {
      assert.equal(kind, 'telegram');
      return { createConnector: ({ onMessage }) => {
        offer = onMessage;
        return {
          start: async () => ({ id: '100' }), stop: async () => {}, typing: async () => {},
          send: async () => {},
        };
      } };
    },
  });
  host.store.save({ id: 'fixture-bot', name: 'Fixture', model: configuredModel, apps: [
    { id: 'app', template: 'telegram', serverName: 'telegram', values: { token: 'fixture-token' } },
  ] });
  host.channels.sync();
  await waitUntil(() => host.channels._live.get('fixture-bot/app')?.account?.id === '100', 'fake Host connector did not connect');
  assert.equal(typeof offer, 'function');
  return { host, offer, modelSelections, modelRequests, attachmentBytes, agents, failures, submitted };
}

const hostOrigin = { isDirect: true, userId: '42', chatId: '42', userName: 'Synthetic' };
const fixtureStickerImage = () => ({ mediaType: 'image/webp', data: frown.toString('base64'), name: 'sticker.webp' });

test('unannotated DM becomes a vision request on the bot’s selected model', { timeout: 5000 }, async (t) => {
  const { offer, modelSelections, modelRequests, attachmentBytes, agents, failures } = await hostFixture(t);
  const configuredModel = { provider: 'fixture-provider', model: 'fixture-existing-vision' };
  const origin = hostOrigin;
  const waitFor = async (n) => {
    for (let i = 0; i < 200 && modelRequests.length < n && !failures.length; i++) await delay(5);
    assert.deepEqual(failures, []);
    assert.equal(modelRequests.length, n);
  };
  // Bootstrap on the Bot's normal route, then compare the next turn on the same session/model.
  offer({ ...origin, messageId: '1', text: 'Compare how the next sticker looks.' });
  await waitFor(1);
  offer({ ...origin, messageId: '2', loadSticker: async () => fixtureStickerImage() });
  await waitFor(2);
  assert.deepEqual(modelSelections, [configuredModel]);
  assert.equal(agents.size, 1);
  assert.deepEqual(modelRequests.map(({ provider, model }) => ({ provider, model })), [configuredModel, configuredModel]);
  const plain = modelRequests[0].messages[0].content;
  const [previous, latest] = modelRequests[1].messages;
  assert.deepEqual(previous.content, plain);
  const visual = latest.content;
  assert.match(plain.map((part) => part.text).join(''), /Compare how the next sticker looks/);
  assert.ok(plain.every((part) => part.type === 'text'));
  assert.equal(attachmentBytes.size, 1);
  assert.deepEqual(visual.filter((part) => part.type === 'image'), [{ type: 'image', mimeType: 'image/webp', data: frown.toString('base64') }]);
  const visualText = visual.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.match(visualText, /interpret the attached sticker image in the context of the conversation/i);
  assert.match(visualText, /unclear, treat it as unknown rather than guessing/i);
  assert.doesNotMatch(visualText, /reviewed sticker annotation|MISLEADING/);
});

for (const stage of ['agent resolution', 'delivery history']) test(`unpairing during Host ${stage} prevents Agent submission`, { timeout: 5000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  let held = false;
  const pause = async (sessionId) => {
    if (held) return;
    held = true;
    entered.resolve(sessionId);
    await release.promise;
  };
  const { host, offer, agents, attachmentBytes, submitted, modelRequests } = await hostFixture(t, {
    paired: [pair(42), pair(43)],
    ...(stage === 'agent resolution' ? { beforeResolve: pause } : { readHistory: async (sessionId) => { await pause(sessionId); return []; } }),
    release: release.resolve,
  });
  offer({ ...hostOrigin, messageId: '1', loadSticker: async () => fixtureStickerImage() });
  const sessionId = await entered.promise;
  assert.ok(agents.has(sessionId));
  assert.equal(attachmentBytes.size, 1, 'the sticker must already be admitted when Host delivery pauses');
  assert.deepEqual(submitted, []);
  assert.equal(host.channels.unpair('fixture-bot', 'app', '42'), true);
  release.resolve();
  await nextTurn();
  assert.deepEqual(submitted, []);
  assert.deepEqual(modelRequests, []);

  // Positive control: the same Host and fake Agent can still accept an authorized input.
  offer({ ...hostOrigin, userId: '43', chatId: '43', messageId: '1', text: 'still paired' });
  await waitUntil(() => submitted.length >= 1, 'the other paired DM did not reach the fake Agent');
  assert.deepEqual(submitted.map(({ id }) => id), ['bots:chat:fixture-bot/app:43:1']);
  assert.equal(modelRequests.length, 1);
  assert.ok(modelRequests[0].messages[0].content.every(({ type }) => type === 'text'));
});

test('rejects unsafe paths before download and bounds actual response bytes', async () => {
  await assert.rejects(fetchStaticSticker('fixture', {
    getFile: async () => ({ file_path: '../sticker.webp' }),
    fetchFile: async () => assert.fail('unsafe path was fetched'),
  }), /not a bounded static WebP/);
  await assert.rejects(fetchStaticSticker('fixture', {
    getFile: async () => ({ file_path: 'stickers/fixture.webp' }),
    fetchFile: async () => new Response(new Uint8Array(MAX_STICKER_BYTES + 1)),
  }), /not a bounded static WebP/);
  const animated = Buffer.from(smile);
  animated.write('ANIM', 12, 4, 'ascii');
  await assert.rejects(fetchStaticSticker('fixture', {
    getFile: async () => ({ file_path: 'stickers/fixture.webp' }),
    fetchFile: async () => new Response(animated),
  }), /not a bounded static WebP/);
});
