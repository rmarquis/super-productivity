import {Injectable} from '@angular/core';
import {select, Store} from '@ngrx/store';
import {EMPTY, Observable, of} from 'rxjs';
import {WorkContext, WorkContextState, WorkContextThemeCfg, WorkContextType} from './work-context.model';
import {PersistenceService} from '../../core/persistence/persistence.service';
import {loadWorkContextState, setActiveWorkContext} from './store/work-context.actions';
import {initialContextState, selectActiveContextId, selectActiveContextTypeAndId} from './store/work-context.reducer';
import {NavigationStart, Router, RouterEvent} from '@angular/router';
import {distinctUntilChanged, filter, map, switchMap} from 'rxjs/operators';
import {TaskService} from '../tasks/task.service';
import {MY_DAY_TAG} from '../tag/tag.const';
import {TagService} from '../tag/tag.service';
import {TaskWithSubTasks} from '../tasks/task.model';
import {ProjectService} from '../project/project.service';
import {distinctUntilChangedObject} from '../../util/distinct-until-changed-object';

@Injectable({
  providedIn: 'root',
})
export class WorkContextService {
  activeWorkContextId$ = this._store$.pipe(select(selectActiveContextId));
  activeWorkContextTypeAndId$ = this._store$.pipe(
    select(selectActiveContextTypeAndId),
    distinctUntilChanged(distinctUntilChangedObject)
  );
  activeWorkContext$: Observable<WorkContext> = this.activeWorkContextTypeAndId$.pipe(
    switchMap(({activeId, activeType}) => {
      if (activeType === WorkContextType.TAG) {
        return this._tagService.getTagById$(activeId).pipe(
          // TODO find out why this is sometimes undefined
          filter(p => !!p),
          map(tag => ({
            ...tag,
            routerLink: `tag/${tag.id}`
          }))
        );
      }
      if (activeType === WorkContextType.PROJECT) {
        return this._projectService.getByIdLive$(activeId).pipe(
          // TODO find out why this is sometimes undefined
          filter(p => !!p),
          map(project => ({
            ...project,
            icon: null,
            taskIds: project.todaysTaskIds || [],
            backlogTaskIds: project.backlogTaskIds || [],
            routerLink: `project/${project.id}`
          })),
        );
      }
      return EMPTY;
    }),
    // TODO find out why this is sometimes undefined
    filter(ctx => !!ctx),
  );

  undoneTasks$: Observable<TaskWithSubTasks[]> = this.activeWorkContext$.pipe(
    switchMap(activeWorkContext => this._taskService.getByIds$(activeWorkContext.taskIds)),
    map(tasks => tasks.filter(task => task && !task.isDone))
  );

  doneTasks$: Observable<TaskWithSubTasks[]> = this.activeWorkContext$.pipe(
    switchMap(activeWorkContext => this._taskService.getByIds$(activeWorkContext.taskIds)),
    map(tasks => tasks.filter(task => task && task.isDone))
  );

  mainWorkContexts$: Observable<WorkContext[]> =
    this._tagService.getTagById$(MY_DAY_TAG.id).pipe(
      switchMap(myDayTag => of([
          ({
            ...myDayTag,
            routerLink: `tag/${myDayTag.id}`
          } as WorkContext)
        ])
      ),
    );

  currentTheme$: Observable<WorkContextThemeCfg> = this.activeWorkContext$.pipe(
    map(awc => awc.theme)
  );

  constructor(
    private _store$: Store<WorkContextState>,
    private _persistenceService: PersistenceService,
    private _taskService: TaskService,
    private _projectService: ProjectService,
    private _tagService: TagService,
    private _router: Router,
  ) {
    this._router.events.pipe(
      filter(event => event instanceof NavigationStart),
    ).subscribe(({url}: RouterEvent) => {
        const split = url.split('/');
        const id = split[2];

        if (url.match(/tag\/.+\/tasks/)) {
          this.setActiveContext(id, WorkContextType.TAG);
        } else if (url.match(/project\/.+\/tasks/)) {
          this.setActiveContext(id, WorkContextType.PROJECT);
        }
      }
    );
  }

  async load() {
    const state = await this._persistenceService.context.loadState() || initialContextState;
    this._store$.dispatch(loadWorkContextState({state}));
  }

  setActiveContext(activeId: string, activeType: WorkContextType) {
    this._store$.dispatch(setActiveWorkContext({activeId, activeType}));
  }
}