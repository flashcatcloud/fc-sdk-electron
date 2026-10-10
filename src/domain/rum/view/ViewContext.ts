import { app } from 'electron';
import * as path from 'node:path';
import { DISCARDED, SKIPPED, timeStampNow, type TimeStamp } from '@flashcatcloud/browser-core';
import type { FormatHooks } from '../../../assembly';
import { DiskValueHistory } from '../../../tools/DiskValueHistory';
import { SESSION_TIME_OUT_DELAY } from '../../session';

export const VIEW_HISTORY_FILE_NAME = '_dd_view_history';

export interface MainView {
  id: string;
  startTime: TimeStamp;
}

export class ViewContext {
  private readonly history: DiskValueHistory<string>;

  private constructor(history: DiskValueHistory<string>, hooks: FormatHooks) {
    this.history = history;

    hooks.registerRum((params) => {
      // The view in force at the time, or the one the event names itself when none was: a crash
      // reported on the next launch is not lost for want of its view.
      const id = this.history.find(params.startTime) ?? params.viewId;
      if (id === undefined) return DISCARDED;
      return { view: { id, name: 'main process', url: 'electron://main-process' } }; // TODO(RUM-14657) improve name / url
    });

    hooks.registerTelemetry((params) => {
      const id = this.history.find(params.startTime);
      if (id === undefined) return SKIPPED;
      return { view: { id } };
    });

    hooks.registerSpan((params) => {
      const id = this.history.find(params.startTime);
      if (id === undefined) return DISCARDED;
      return { meta: { '_dd.view.id': id } };
    });
  }

  static async init(hooks: FormatHooks, expireDelay = SESSION_TIME_OUT_DELAY): Promise<ViewContext> {
    const filePath = path.join(app.getPath('userData'), VIEW_HISTORY_FILE_NAME);
    const history = await DiskValueHistory.init<string>({ filePath, expireDelay });
    return new ViewContext(history, hooks);
  }

  /** The main-process view in force at `startTime`, or `undefined` when there was none. */
  findView(startTime: TimeStamp): MainView | undefined {
    const entry = this.history.findEntry(startTime);
    return entry && { id: entry.value, startTime: entry.startTime };
  }

  add(id: string, startTime: TimeStamp = timeStampNow()): void {
    this.history.add(id, startTime);
  }

  close(endTime: TimeStamp = timeStampNow()): void {
    this.history.closeActive(endTime);
  }
}
