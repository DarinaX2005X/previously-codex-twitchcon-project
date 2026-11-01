import {parentPort, workerData} from 'node:worker_threads';
import {WebSocketServer, WebSocket} from 'ws';
const {rate, count} = workerData;
const server = new WebSocketServer({host: '127.0.0.1', port: 0});
const peers = new Set(), pendingDeletes = [];
let timer, started = 0, offered = 0, withPeer = 0, withoutPeer = 0, sequence = 0, deleteSequence = 0;
const drifts = [];
const frame = (id, type, event) => JSON.stringify({metadata: {message_id: id, message_type: 'notification', message_timestamp: new Date().toISOString()}, payload: {subscription: {type, version: '1'}, event: {broadcaster_user_id: '123', ...event}}});
function deliverDeletes() {
  const peer = [...peers].find(value => value.readyState === WebSocket.OPEN);
  if (!peer) return;
  while (pendingDeletes.length) {const id = pendingDeletes.shift(); peer.send(frame(`delete-${++deleteSequence}`, 'channel.chat.message_delete', {message_id: id}));}
}
server.on('connection', peer => {
  peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer));
  peer.send(JSON.stringify({metadata: {message_id: `welcome-${++sequence}`, message_type: 'session_welcome', message_timestamp: new Date().toISOString()}, payload: {session: {id: `worker-session-${sequence}`, keepalive_timeout_seconds: 10}}}));
  deliverDeletes();
});
const keepalive = setInterval(() => {for (const peer of peers) if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({metadata: {message_id: `keepalive-${++sequence}`, message_type: 'session_keepalive', message_timestamp: new Date().toISOString()}, payload: {}}));}, 5000);
server.on('listening', () => parentPort.postMessage({type: 'ready', port: server.address().port}));
function next() {
  // Windows timer granularity can exceed5ms. Offer every elapsed slot on this independent
  // producer turn rather than silently lowering the requested rate to one message per timer.
  while(offered<count&&started+offered*1000/rate<=Date.now()){
    const plannedAt = started + offered * 1000 / rate, offeredAt = Date.now(), id = `burst-${offered}`;
    drifts.push(offeredAt - plannedAt);
    const peer = [...peers].find(value => value.readyState === WebSocket.OPEN);
    if (peer) {withPeer++; peer.send(frame(id, 'channel.chat.message', {chatter_user_id: '456', message_id: id, message: {text: `Authored burst ${offered}`}, fixturePlannedAt: plannedAt, fixtureOfferedAt: offeredAt}));}
    else withoutPeer++;
    offered++;
  }
  if (offered === count) {
    const sorted = drifts.toSorted((a, b) => a - b);
    parentPort.postMessage({type: 'done', started, ended: Date.now(), offered, withPeer, withoutPeer, producerDriftMs: {p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1)}});
  } else timer = setTimeout(next, Math.max(0, started + offered * 1000 / rate - Date.now()));
}
parentPort.on('message', message => {
  if (message.type === 'start' && !started) {started = Date.now(); next();}
  if (message.type === 'delete') {pendingDeletes.push(message.id); deliverDeletes();}
  if (message.type === 'stop') {clearTimeout(timer); clearInterval(keepalive); for (const peer of peers) peer.terminate(); server.close(() => process.exit(0));}
});
