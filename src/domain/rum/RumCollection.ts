import { EventManager } from '../../event';
import type { FormatHooks } from '../../assembly';
import { ErrorCollection, CrashCollection, ProcessGoneCollection } from './error';
import { OperationCollection } from './operation';
import { ViewCollection, ViewContext } from './view';
import type { RendererRegistry } from '../RendererRegistry';
import type { StackPathNormalizer } from '../StackPathNormalizer';
import type { SessionManager } from '../session';

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
    rendererRegistry: RendererRegistry,
    stackPathNormalizer: StackPathNormalizer,
    sessionManager: SessionManager
  ): Promise<RumCollection> {
    const viewContext = await ViewContext.init(hooks);
    const viewCollection = ViewCollection.start(eventManager, viewContext);
    const errorCollection = new ErrorCollection(eventManager, stackPathNormalizer);
    const operationCollection = new OperationCollection(eventManager);
    const processGoneCollection = new ProcessGoneCollection(eventManager, rendererRegistry);
    CrashCollection.start(eventManager, sessionManager, (startTime) => viewContext.findView(startTime));
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
