import {Injectable} from '@angular/core';
import {ProjectService} from '../../project/project.service';
import {GithubCfg} from './github';
import {SnackService} from '../../../core/snack/snack.service';
import {HttpClient, HttpErrorResponse, HttpHeaders} from '@angular/common/http';
import {GITHUB_API_BASE_URL} from './github.const';
import {combineLatest, Observable, ObservableInput, throwError} from 'rxjs';
import {GithubOriginalComment, GithubOriginalIssue} from './github-api-responses';
import {catchError, map, share, switchMap, take} from 'rxjs/operators';
import {mapGithubIssue, mapGithubIssueToSearchResult} from './github-issue/github-issue-map.util';
import {GithubComment, GithubIssue} from './github-issue/github-issue.model';
import {SearchResultItem} from '../issue.model';
import {HANDLED_ERROR_PROP_STR} from '../../../app.constants';
import {T} from '../../../t.const';

const BASE = GITHUB_API_BASE_URL;

@Injectable({
  providedIn: 'root',
})
export class GithubApiService {

  private _cfg: GithubCfg;
  private _header: HttpHeaders;

  constructor(
    private _projectService: ProjectService,
    private _snackService: SnackService,
    private _http: HttpClient,
  ) {
    this._projectService.currentGithubCfg$.subscribe((cfg: GithubCfg) => {
      this._cfg = cfg;
      this.setHeader(cfg.token);
    });
  }

  public setHeader(accessToken: string) {
    if (accessToken) {
      this._header = new HttpHeaders({
        Authorization: 'token ' + accessToken
      });
    } else {
      this._header = null;
    }
  }

  getById$(id: number): Observable<GithubIssue> {
    this._checkSettings();

    return this.getCompleteIssueDataForRepo$()
      .pipe(switchMap(issues => issues.filter(issue => issue.id === id)));
  }

  getCompleteIssueDataForRepo$(repo = this._cfg.repo, isSkipCheck = false, isForceRefresh = false): Observable<GithubIssue[]> {
    if (!isSkipCheck) {
      this._checkSettings();
    }
    return combineLatest([
      this._getAllIssuesForRepo$(repo, isSkipCheck),
      this._getAllCommentsForRepo$(repo, isSkipCheck),
    ]).pipe(
      take(1),
      map(([issues, comments]) => this._mergeIssuesAndComments(issues, comments)),
    );
    // }
  }


  searchIssueForRepo$(searchText: string, repo = this._cfg.repo): Observable<SearchResultItem[]> {
    const filterFn = issue => {
      try {
        return issue.title.toLowerCase().match(searchText.toLowerCase())
          || issue.body.toLowerCase().match(searchText.toLowerCase());
      } catch (e) {
        console.warn('RegEx Error', e);
        return false;
      }
    };
    this._checkSettings();

    return this.getCompleteIssueDataForRepo$(repo)
      .pipe(
        catchError(this._handleRequestError$.bind(this)),
        // a single request should suffice
        share(),
        map((issues: GithubIssue[]) =>
          issues.filter(filterFn)
            .map(mapGithubIssueToSearchResult)
        ),
      );
  }

  refreshIssuesCacheIfOld(): void {
    this.getCompleteIssueDataForRepo$().subscribe();
  }

  getIssueWithCommentsByIssueNumber$(issueNumber: number): Observable<GithubIssue> {
    this._checkSettings();
    return combineLatest([
      this._http.get(`${BASE}repos/${this._cfg.repo}/issues/${issueNumber}`,
        {headers: this._header ? this._header : {}}),
      this._http.get(`${BASE}repos/${this._cfg.repo}/issues/${issueNumber}/comments`,
        {headers: this._header ? this._header : {}}),
    ]).pipe(
      catchError(this._handleRequestError$.bind(this)),
      map(([issue, comments]: [GithubOriginalIssue, GithubOriginalComment[]]) => {
        return {
          ...mapGithubIssue(issue),
          comments,
        };
      }),
    );
  }

  private _getAllIssuesForRepo$(repo = this._cfg.repo, isSkipCheck = false): Observable<GithubIssue[]> {
    if (!isSkipCheck) {
      this._checkSettings();
    }
    return this._http.get(
      `${BASE}repos/${repo}/issues?per_page=100`,
      {headers: this._header ? this._header : {}}
    ).pipe(
      catchError(this._handleRequestError$.bind(this)),
      map((issues: GithubOriginalIssue[]) => issues ? issues.map(mapGithubIssue) : []),
    );
  }

  private _getAllCommentsForRepo$(repo = this._cfg.repo, isSkipCheck = false): Observable<GithubComment[]> {
    if (!isSkipCheck) {
      this._checkSettings();
    }
    return combineLatest([
      // the last 500 should hopefully be enough
      this._getCommentsPageForRepo$(1, repo, isSkipCheck),
      this._getCommentsPageForRepo$(2, repo, isSkipCheck),
      this._getCommentsPageForRepo$(3, repo, isSkipCheck),
      this._getCommentsPageForRepo$(4, repo, isSkipCheck),
      this._getCommentsPageForRepo$(5, repo, isSkipCheck),
    ])
      .pipe(
        catchError(this._handleRequestError$.bind(this)),
        map(([p1, p2, p3, p4, p5]) => [].concat(p1, p2, p3, p4, p5))
      );
  }

  private _getCommentsPageForRepo$(page = 1, repo = this._cfg.repo, isSkipCheck = false): Observable<GithubComment[]> {
    if (!isSkipCheck) {
      this._checkSettings();
    }
    return this._http.get(
      `${BASE}repos/${repo}/issues/comments?sort=created&direction=desc&per_page=100&page=${page}`,
      {headers: this._header ? this._header : {}}
    ).pipe(
      catchError(this._handleRequestError$.bind(this)),
      map(res => res as GithubComment[])
    );
  }

  private _checkSettings() {
    if (!this._isValidSettings()) {
      this._snackService.open({
        type: 'ERROR',
        msg: T.F.GITHUB.S.ERR_NOT_CONFIGURED
      });
      const e = new Error(`Not enough settings`);
      e[HANDLED_ERROR_PROP_STR] = 'Not enough settings';
      throw e;
    }
  }

  private _handleRequestError$(error: HttpErrorResponse, caught: Observable<object>): ObservableInput<{}> {
    console.error(error);
    if (error.error instanceof ErrorEvent) {
      // A client-side or network error occurred. Handle it accordingly.
      this._snackService.open({
        type: 'ERROR',
        msg: T.F.GITHUB.S.ERR_NETWORK,
      });
    } else {
      // The backend returned an unsuccessful response code.
      this._snackService.open({
        type: 'ERROR',
        translateParams: {
          statusCode: error.status,
          errorMsg: error.error && error.error.message,
        },
        msg: T.F.GITHUB.S.ERR_NOT_CONFIGURED,
      });
    }
    if (error && error.message) {
      return throwError({[HANDLED_ERROR_PROP_STR]: 'Github: ' + error.message});
    }

    return throwError({[HANDLED_ERROR_PROP_STR]: 'Github: Api request failed.'});
  }

  private _mergeIssuesAndComments(issues: GithubIssue[], comments: GithubComment[]): GithubIssue[] {
    return issues.map(issue => {
      return {
        ...issue,
        comments: comments.filter(comment => {
          return (comment.issue_url === issue.apiUrl);
        }),
      };
    });
  }

  private _isValidSettings(): boolean {
    const cfg = this._cfg;
    return cfg && cfg.repo && cfg.repo.length > 0;
  }
}

//
// searchIssue(searchText: string): Observable<SearchResultItem[]> {
//   this._checkSettings();
// return this._http.get(`${BASE}search/issues?q=${encodeURI(searchText)}`)
//   .pipe(
//     catchError(this._handleRequestError.bind(this)),
//     map((res: GithubIssueSearchResult) => {
//       if (res && res.items) {
//         return res.items.map(mapGithubIssue).map(mapGithubIssueToSearchResult);
//       } else {
//         return [];
//       }
//     }),
//   );
// }
//
//

//
// getCommentsForIssue(issueId: number): Observable<any> {
//   this._checkSettings();
// return this._http.get(BASE + `${BASE}repos/${this._cfg.repo}/issues/${issueId}/comments`)
//   .pipe(
//     catchError(this._handleRequestError.bind(this)),
//   );
// }
