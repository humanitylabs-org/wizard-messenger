// Issue 402: what a picked file becomes in the tray, and the messages one Send makes from the tray.
const test = require('node:test');
const assert = require('node:assert/strict');
const {attachKind, sendJobs, trayPhotos} = require('../static/unified.js');

test('a phone video is a video unless File was chosen', () => {
  assert.equal(attachKind({type: 'video/mp4', name: '1000191908.mp4'}), 'video');
  assert.equal(attachKind({type: 'video/quicktime', name: 'IMG_0001.MOV'}), 'video');
  assert.equal(attachKind({type: 'video/webm', name: 'screen.webm'}), 'video');
  assert.equal(attachKind({type: '', name: 'clip.MP4'}), 'video', 'some pickers give no type');
  assert.equal(attachKind({type: 'application/octet-stream', name: 'clip.mov'}), 'video', 'a saved draft keeps videos as plain bytes');
  assert.equal(attachKind({type: 'video/mp4', name: 'clip.mp4'}, true), 'file', 'File keeps a video a file');
  assert.equal(attachKind({type: 'image/jpeg', name: 'a.jpg'}, true), 'file');
  assert.equal(attachKind({type: 'image/png', name: 'a.png'}), 'photo');
  assert.equal(attachKind({type: 'video/x-msvideo', name: 'old.avi'}), 'file', 'a video phones do not make stays a file');
  assert.equal(attachKind({type: 'application/pdf', name: 'report.pdf'}), 'file');
});

const P1 = {key: 'p1', url: 'blob:p1'}, P2 = {key: 'p2', url: 'blob:p2'}, V = {key: 'v', video: true, local: 'blob:v', url: 'blob:vf'}, V2 = {key: 'v2', video: true, local: 'blob:v2'}, F = {key: 'f', file: true};
const shape = jobs => jobs.map(j => [j.photos ? 'album' : j.photo ? 'photo' : j.video ? 'video:' + j.video.key : j.file ? 'file' : 'text', j.text, j.reply ? 'reply' : '']);

test('each video is its own message; words ride on the first picture', () => {
  assert.deepEqual(shape(sendJobs([V], 'look', {reply: {id: 'r'}})), [['video:v', 'look', 'reply']]);
  assert.deepEqual(shape(sendJobs([P1, P2, V], 'beach')), [['album', 'beach', ''], ['video:v', '', '']]);
  assert.deepEqual(shape(sendJobs([V, V2, F], 'two')), [['video:v', 'two', ''], ['video:v2', '', ''], ['file', '', '']]);
  assert.deepEqual(shape(sendJobs([P1, V], '')), [['photo', '', ''], ['video:v', '', '']]);
});

test('LINE: words go after the photos and videos as their own message', () => {
  assert.deepEqual(shape(sendJobs([P1, P2, V], 'beach', {apart: true})), [['album', '', ''], ['video:v', '', ''], ['text', 'beach', '']]);
  assert.deepEqual(shape(sendJobs([V], 'look', {apart: true, reply: {id: 'r'}})), [['video:v', '', 'reply'], ['text', 'look', '']]);
});

test('photos and files behave as before', () => {
  assert.deepEqual(shape(sendJobs([], 'hi')), [['text', 'hi', '']]);
  assert.deepEqual(shape(sendJobs([P1], 'hi')), [['photo', 'hi', '']]);
  assert.deepEqual(shape(sendJobs([P1, P2], 'hi', {apart: true})), [['album', '', ''], ['text', 'hi', '']]);
  assert.deepEqual(shape(sendJobs([F, F], 'hi')), [['file', 'hi', ''], ['file', '', '']]);
  assert.deepEqual(shape(sendJobs([P1, F], 'hi')), [['photo', 'hi', ''], ['file', '', '']]);
});

test('a staged video opens from the phone copy', () => {
  const t = trayPhotos([P1, V, F], V);
  assert.deepEqual(t, {items: [{url: 'blob:p1', kind: 'image', name: 'Photo'}, {url: 'blob:v', kind: 'video', name: 'Video'}], at: 1});
});
