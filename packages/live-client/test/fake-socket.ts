import type { ClientFrame, ServerFrame } from '@indoorkit/protocol';
import type { WebSocketLike } from '../src/index';

/** 假的 WebSocket：测试代替服务器打开、发帧、断开 */
export class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  static last() {
    return FakeSocket.all.at(-1)!;
  }
  readyState = 0;
  sent: ClientFrame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  // 以下由测试调用，扮演服务器
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(frame: ServerFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  pushRaw(text: string) {
    this.onmessage?.({ data: text });
  }
  drop() {
    this.close();
  }
  /** Node 的 WebSocket 握手被拒时只发 error，不发 close */
  refuse() {
    this.onerror?.();
  }
}
