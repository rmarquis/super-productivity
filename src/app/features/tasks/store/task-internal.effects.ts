import {Injectable} from '@angular/core';
import {Actions, Effect, ofType} from '@ngrx/effects';
import {SetCurrentTask, TaskActionTypes, UpdateTask} from './task.actions';
import {select, Store} from '@ngrx/store';
import {filter, map, mergeMap, withLatestFrom} from 'rxjs/operators';
import {selectTaskFeatureState} from './task.selectors';
import {selectMiscConfig} from '../../config/store/global-config.reducer';
import {TaskState} from '../task.model';
import {EMPTY, of} from 'rxjs';
import {MiscConfig} from '../../config/global-config.model';
import {moveTaskToBacklogList, moveTaskToBacklogListAuto} from '../../work-context/store/work-context-meta.actions';
import {WorkContextService} from '../../work-context/work-context.service';

@Injectable()
export class TaskInternalEffects {
  @Effect()
  onAllSubTasksDone$: any = this._actions$.pipe(
    ofType(
      TaskActionTypes.UpdateTask,
    ),
    withLatestFrom(
      this._store$.pipe(select(selectMiscConfig)),
      this._store$.pipe(select(selectTaskFeatureState))
    ),
    filter(([action, miscCfg, state]: [UpdateTask, MiscConfig, TaskState]) =>
      miscCfg && miscCfg.isAutMarkParentAsDone &&
      action.payload.task.changes.isDone &&
      !!(state.entities[action.payload.task.id].parentId)
    ),
    filter(([action, miscCfg, state]) => {
      const task = state.entities[action.payload.task.id];
      const parent = state.entities[task.parentId];
      const undoneSubTasks = parent.subTaskIds.filter(id => !state.entities[id].isDone);
      return undoneSubTasks.length === 0;
    }),
    map(([action, miscCfg, state]) => new UpdateTask({
      task: {
        id: state.entities[action.payload.task.id].parentId,
        changes: {isDone: true},
      }
    })),
  );

  @Effect()
  autoSetNextTask$: any = this._actions$.pipe(
    ofType(
      TaskActionTypes.ToggleStart,
      TaskActionTypes.UpdateTask,
      TaskActionTypes.DeleteTask,
      TaskActionTypes.MoveToArchive,
      TaskActionTypes.MoveToOtherProject,

      moveTaskToBacklogList.type,
      moveTaskToBacklogListAuto.type
    ),
    withLatestFrom(
      this._store$.pipe(select(selectMiscConfig)),
      this._store$.pipe(select(selectTaskFeatureState)),
      this._workContextSession.todaysTaskIds$,
      (action, miscCfg, state, todaysTaskIds) => ({
        action,
        state,
        isAutoStartNextTask: miscCfg.isAutoStartNextTask,
        todaysTaskIds,
      })
    ),
    mergeMap(({action, state, isAutoStartNextTask, todaysTaskIds}) => {
      const currentId = state.currentTaskId;
      let nextId: 'NO_UPDATE' | string | null;

      switch (action.type) {
        case TaskActionTypes.ToggleStart: {
          nextId = state.currentTaskId ? null : this._findNextTask(state, todaysTaskIds);
          break;
        }

        case TaskActionTypes.UpdateTask: {
          const {isDone} = (action as UpdateTask).payload.task.changes;
          const oldId = (action as UpdateTask).payload.task.id;
          const isCurrent = (oldId === currentId);
          nextId = (isDone && isCurrent)

            ? ((isAutoStartNextTask)
              ? this._findNextTask(state, todaysTaskIds, oldId)
              : null)

            : 'NO_UPDATE';
          break;
        }

        case moveTaskToBacklogList.type:
        case moveTaskToBacklogListAuto.type: {
          const isCurrent = (currentId === (action as any).taskId);
          nextId = (isCurrent) ? null : 'NO_UPDATE';
          break;
        }

        // QUICK FIX FOR THE ISSUE
        // TODO better solution
        case TaskActionTypes.DeleteTask: {
          nextId = state.currentTaskId;
          break;
        }

        // NOTE: currently no solution for this, but we're probably fine, as the current task
        // gets unset every time we go to the finish day view
        // case TaskActionTypes.MoveToArchive: {}
      }

      if (nextId === 'NO_UPDATE') {
        return EMPTY;
      } else {
        return of(new SetCurrentTask(nextId));
      }
    })
  );

  constructor(
    private _actions$: Actions,
    private _store$: Store<any>,
    private _workContextSession: WorkContextService,
  ) {
  }

  private _findNextTask(state: TaskState, todaysTaskIds: string[], oldCurrentId?): string {
    let nextId = null;
    const {entities} = state;

    const filterUndoneNotCurrent = (id) => !entities[id].isDone && id !== oldCurrentId;
    const flattenToSelectable = (arr: string[]) => arr.reduce((acc: string[], next: string) => {
      return entities[next].subTaskIds.length > 0
        ? acc.concat(entities[next].subTaskIds)
        : acc.concat(next);
    }, []);

    if (oldCurrentId) {
      const oldCurTask = entities[oldCurrentId];
      if (oldCurTask && oldCurTask.parentId) {
        entities[oldCurTask.parentId].subTaskIds.some((id) => {
          return (id !== oldCurrentId && entities[id].isDone === false)
            ? (nextId = id) && true // assign !!!
            : false;
        });
      }

      if (!nextId) {
        const oldCurIndex = todaysTaskIds.indexOf(oldCurrentId);
        const mainTasksBefore = todaysTaskIds.slice(0, oldCurIndex);
        const mainTasksAfter = todaysTaskIds.slice(oldCurIndex + 1);
        const selectableBefore = flattenToSelectable(mainTasksBefore);
        const selectableAfter = flattenToSelectable(mainTasksAfter);
        nextId = selectableAfter.find(filterUndoneNotCurrent)
          || selectableBefore.reverse().find(filterUndoneNotCurrent);
        nextId = (Array.isArray(nextId)) ? nextId[0] : nextId;

      }
    } else {
      const lastTask = entities[state.lastCurrentTaskId];
      const isLastSelectable = state.lastCurrentTaskId && lastTask && !lastTask.isDone && !lastTask.subTaskIds.length;
      if (isLastSelectable) {
        nextId = state.lastCurrentTaskId;
      } else {
        const selectable = flattenToSelectable(todaysTaskIds).find(filterUndoneNotCurrent);
        nextId = (Array.isArray(selectable)) ? selectable[0] : selectable;
      }
    }

    return nextId;
  }
}


