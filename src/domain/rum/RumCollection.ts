import { EventManager } from '../../event';
import type { FormatHooks } from '../../assembly';
import { ErrorCollection, CrashCollection, ProcessGoneCollection } from './error';
import { OperationCollection } from './operation';
import { ViewCollection } from './view';
import type { RendererRegistry } from '../RendererRegistry';

export class RumCollection {
  private constructor(
    private readonly viewCollection: ViewCollection,
    private readonly errorCollection: ErrorCollection,
    private readonly operationCollection: OperationCollection,
    private readonly processGoneCollection: ProcessGoneCollection
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    rendererRegistry: RendererRegistry
  ): Promise<RumCollection> {
    const viewCollection = await ViewCollection.start(eventManager, hooks);
    const errorCollection = new ErrorCollection(eventManager);
    const operationCollection = new OperationCollection(eventManager);
    const processGoneCollection = new ProcessGoneCollection(eventManager, rendererRegistry);
    CrashCollection.start(eventManager);
    return new RumCollection(viewCollection, errorCollection, operationCollection, processGoneCollection);
  }

  getApi() {
    return {
      ...this.errorCollection.getApi(),
      ...this.operationCollection.getApi(),
    };
  }

  stop(): void {
    this.viewCollection.stop();
    this.errorCollection.stop();
    this.operationCollection.stop();
    this.processGoneCollection.stop();
  }
}
