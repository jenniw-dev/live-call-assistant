export type CaptureSource = 'backend' | 'frontend';

export interface CaptureSessionSocket {
  open: (source: CaptureSource) => Promise<void>;
  sendControl: (type: 'stop') => void;
  close: () => void;
}

export interface CaptureSessionResource {
  stop: () => void;
}

export interface CaptureAttemptGuard {
  isCurrent: () => boolean;
  signal: AbortSignal;
}

export interface CaptureStartRequest<
  Socket extends CaptureSessionSocket,
  Capture extends CaptureSessionResource,
> {
  source: CaptureSource;
  createSocket: (guard: CaptureAttemptGuard) => Socket;
  createCapture?: (guard: CaptureAttemptGuard) => Promise<Capture>;
  onReady: (resources: {
    socket: Socket;
    capture: Capture | null;
    guard: CaptureAttemptGuard;
  }) => void;
  onError: (error: unknown) => void;
}

export class CaptureSessionCoordinator<
  Socket extends CaptureSessionSocket = CaptureSessionSocket,
  Capture extends CaptureSessionResource = CaptureSessionResource,
> {
  private generation = 0;
  private currentPhase: 'idle' | 'starting' | 'active' = 'idle';
  private abortController: AbortController | null = null;
  private socket: Socket | null = null;
  private capture: Capture | null = null;
  private readonly releasedSockets = new WeakSet<object>();
  private readonly releasedCaptures = new WeakSet<object>();

  get phase(): 'idle' | 'starting' | 'active' {
    return this.currentPhase;
  }

  start(request: CaptureStartRequest<Socket, Capture>): boolean {
    if (this.currentPhase !== 'idle') return false;

    this.currentPhase = 'starting';
    const generation = ++this.generation;
    const abortController = new AbortController();
    this.abortController = abortController;
    const guard = {
      isCurrent: () => this.isCurrent(generation),
      signal: abortController.signal,
    };
    void this.runAttempt(generation, abortController, guard, request);
    return true;
  }

  stop(): void {
    ++this.generation;
    this.currentPhase = 'idle';
    this.abortController?.abort();
    this.abortController = null;
    const socket = this.socket;
    const capture = this.capture;
    this.socket = null;
    this.capture = null;
    if (capture) this.releaseCapture(capture);
    if (socket) this.releaseSocket(socket);
  }

  replaceCapture(capture: Capture): boolean {
    if (this.currentPhase !== 'active') {
      this.releaseCapture(capture);
      return false;
    }
    if (this.capture) this.releaseCapture(this.capture);
    this.capture = capture;
    return true;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.currentPhase !== 'idle';
  }

  private async runAttempt(
    generation: number,
    abortController: AbortController,
    guard: CaptureAttemptGuard,
    request: CaptureStartRequest<Socket, Capture>,
  ): Promise<void> {
    let socket: Socket | null = null;
    let capture: Capture | null = null;
    try {
      socket = request.createSocket(guard);
      if (!this.isCurrent(generation)) {
        this.releaseSocket(socket);
        return;
      }
      this.socket = socket;
      await socket.open(request.source);
      if (!this.isCurrent(generation)) {
        this.releaseSocket(socket);
        return;
      }

      if (request.source === 'frontend') {
        if (!request.createCapture) throw new Error('Couldn’t start system audio capture.');
        capture = await request.createCapture(guard);
        if (!this.isCurrent(generation)) {
          this.releaseCapture(capture);
          this.releaseSocket(socket);
          return;
        }
        this.capture = capture;
      }

      if (!this.isCurrent(generation)) {
        if (capture) this.releaseCapture(capture);
        this.releaseSocket(socket);
        return;
      }
      this.currentPhase = 'active';
      request.onReady({ socket, capture, guard });
    } catch (error) {
      const current = this.isCurrent(generation);
      if (current) {
        this.currentPhase = 'idle';
        abortController.abort();
        if (this.abortController === abortController) this.abortController = null;
        this.socket = null;
        this.capture = null;
      }
      if (capture) this.releaseCapture(capture);
      if (socket) this.releaseSocket(socket);
      if (!current) return;
      request.onError(error);
    }
  }

  private releaseSocket(socket: Socket): void {
    if (this.releasedSockets.has(socket)) return;
    this.releasedSockets.add(socket);
    try { socket.sendControl('stop'); } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
  }

  private releaseCapture(capture: Capture): void {
    if (this.releasedCaptures.has(capture)) return;
    this.releasedCaptures.add(capture);
    try { capture.stop(); } catch { /* ignore */ }
  }
}
