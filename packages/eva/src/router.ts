export class FrameRouter {
  private readonly routes = new Map<string, string>();

  public set(frameId: string, clientId: string): void {
    this.routes.set(frameId, clientId);
  }

  public get(frameId: string): string | undefined {
    return this.routes.get(frameId);
  }

  public delete(frameId: string): void {
    this.routes.delete(frameId);
  }
}
