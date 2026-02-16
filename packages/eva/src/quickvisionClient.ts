export type QuickVisionConnectionState = 'connected' | 'disconnected';

export class QuickVisionClient {
  private state: QuickVisionConnectionState = 'disconnected';

  public getState(): QuickVisionConnectionState {
    return this.state;
  }

  public connect(): void {
    this.state = 'connected';
  }

  public disconnect(): void {
    this.state = 'disconnected';
  }
}
