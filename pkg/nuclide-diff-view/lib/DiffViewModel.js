'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {
  HgRepositoryClient,
} from '../../nuclide-hg-repository-client';
import type {
  RevisionsState,
  FileChangeStatusValue,
  CommitModeType,
  CommitModeStateType,
  PublishModeType,
  PublishModeStateType,
  DiffModeType,
  DiffOptionType,
  UIProvider,
  UIElement,
} from './types';
import type {
  RevisionInfo,
} from '../../nuclide-hg-rpc/lib/HgService';
import type {NuclideUri} from '../../commons-node/nuclideUri';
import type {PhabricatorRevisionInfo} from '../../nuclide-arcanist-rpc/lib/utils';
import typeof * as BoundActionCreators from './redux/Actions';

type FileDiffState = {
  revisionInfo: RevisionInfo,
  committedContents: string,
  filesystemContents: string,
};

type FileChangeState = {
  filePath: NuclideUri,
  oldContents: string,
  newContents: string,
  fromRevisionTitle: string,
  toRevisionTitle: string,
  compareRevisionInfo: ?RevisionInfo,
  inlineComponents?: Array<UIElement>,
};

export type DiffEntityOptions = {
  file?: NuclideUri,
  directory?: NuclideUri,
  viewMode?: DiffModeType,
  commitMode?: CommitModeType,
};

import {getPhabricatorRevisionFromCommitMessage} from '../../nuclide-arcanist-rpc/lib/utils';
import {CompositeDisposable, Emitter} from 'atom';
import {shell} from 'electron';
import {
  DiffMode,
  DiffOption,
  CommitMode,
  CommitModeState,
  PublishMode,
  PublishModeState,
} from './constants';
import invariant from 'assert';
import {repositoryForPath} from '../../nuclide-hg-git-bridge';
import {track, trackTiming} from '../../nuclide-analytics';
import {serializeAsyncCall} from '../../commons-node/promise';
import {mapUnion, mapFilter} from '../../commons-node/collection';
import {hgConstants} from '../../nuclide-hg-rpc';
import nuclideUri from '../../commons-node/nuclideUri';
import RepositoryStack from './RepositoryStack';
import {Observable, Subject} from 'rxjs';
import {notifyInternalError} from './notifications';
import {bufferForUri, loadBufferForUri} from '../../commons-atom/text-editor';
import {getLogger} from '../../nuclide-logging';
import {getArcanistServiceByNuclideUri} from '../../nuclide-remote-connection';
import {
  getAmendMode,
  promptToCleanDirtyChanges,
  processArcanistOutput,
} from './utils';

const ACTIVE_BUFFER_CHANGE_MODIFIED_EVENT = 'active-buffer-change-modified';
const DID_UPDATE_STATE_EVENT = 'did-update-state';

export function formatFileDiffRevisionTitle(revisionInfo: RevisionInfo): string {
  const {hash, bookmarks} = revisionInfo;
  return `${hash}` + (bookmarks.length === 0 ? '' : ` - (${bookmarks.join(', ')})`);
}

export function getRevisionUpdateMessage(phabricatorRevision: PhabricatorRevisionInfo): string {
  return `

# Updating ${phabricatorRevision.name}
#
# Enter a brief description of the changes included in this update.
# The first line is used as subject, next lines as comment.`;
}

// Returns a string with all newline strings, '\\n', converted to literal newlines, '\n'.
function convertNewlines(message: string): string {
  return message.replace(/\\n/g, '\n');
}

function getInitialFileChangeState(): FileChangeState {
  return {
    fromRevisionTitle: 'No file selected',
    toRevisionTitle: 'No file selected',
    filePath: '',
    oldContents: '',
    newContents: '',
    compareRevisionInfo: null,
  };
}

function getInitialState(): State {
  return {
    ...getInitialFileChangeState(),
    viewMode: DiffMode.BROWSE_MODE,
    commitMessage: null,
    commitMode: CommitMode.COMMIT,
    commitModeState: CommitModeState.READY,
    shouldRebaseOnAmend: true,
    publishMessage: null,
    publishMode: PublishMode.CREATE,
    publishModeState: PublishModeState.READY,
    headCommitMessage: null,
    dirtyFileChanges: new Map(),
    selectedFileChanges: new Map(),
    showNonHgRepos: true,
    revisionsState: null,
  };
}

export function viewModeToDiffOption(viewMode: DiffModeType): DiffOptionType {
  switch (viewMode) {
    case DiffMode.COMMIT_MODE:
      return DiffOption.DIRTY;
    case DiffMode.PUBLISH_MODE:
      return DiffOption.LAST_COMMIT;
    case DiffMode.BROWSE_MODE:
      return DiffOption.COMPARE_COMMIT;
    default:
      throw new Error('Unrecognized view mode!');
  }
}

// TODO(most): Cleanup to avoid using `.do()` and have side effects:
// (notifications & publish updates).
export function createPhabricatorRevision(
  repository: HgRepositoryClient,
  publishUpdates: Subject<any>,
  headCommitMessage: string,
  publishMessage: string,
  amended: boolean,
  lintExcuse: ?string,
): Observable<void> {
  const filePath = repository.getProjectDirectory();
  let amendStream = Observable.empty();
  if (!amended && publishMessage !== headCommitMessage) {
    getLogger().info('Amending commit with the updated message');
    // We intentionally amend in clean mode here, because creating the revision
    // amends the commit message (with the revision url), breaking the stack on top of it.
    // Consider prompting for `hg amend --fixup` after to rebase the stack when needed.
    amendStream = repository.amend(publishMessage, hgConstants.AmendMode.CLEAN).do({
      complete: () => atom.notifications.addSuccess('Commit amended with the updated message'),
    });
  }

  return Observable.concat(
    // Amend head, if needed.
    amendStream,
    // Create a new revision.
    Observable.defer(() => {
      const stream = getArcanistServiceByNuclideUri(filePath)
        .createPhabricatorRevision(filePath, lintExcuse)
        .refCount();

      return processArcanistOutput(stream)
        .startWith({level: 'log', text: 'Creating new revision...\n'})
        .do(message => publishUpdates.next(message));
    }),

    Observable.defer(() =>
      Observable.fromPromise(repository.async.getHeadCommitMessage())
        .do(commitMessage => {
          const phabricatorRevision = getPhabricatorRevisionFromCommitMessage(commitMessage || '');
          if (phabricatorRevision != null) {
            notifyRevisionStatus(phabricatorRevision, 'created');
          }
        })),
  ).ignoreElements();
}

// TODO(most): Cleanup to avoid using `.do()` and have side effects:
// (notifications & publish updates).
export function updatePhabricatorRevision(
  repository: HgRepositoryClient,
  publishUpdates: Subject<any>,
  headCommitMessage: string,
  publishMessage: string,
  allowUntracked: boolean,
  lintExcuse: ?string,
): Observable<void> {
  const filePath = repository.getProjectDirectory();

  const phabricatorRevision = getPhabricatorRevisionFromCommitMessage(headCommitMessage);
  if (phabricatorRevision == null) {
    return Observable.throw(new Error('A phabricator revision must exist to update!'));
  }

  const updateTemplate = getRevisionUpdateMessage(phabricatorRevision).trim();
  const userUpdateMessage = publishMessage.replace(updateTemplate, '').trim();
  if (userUpdateMessage.length === 0) {
    return Observable.throw(new Error('Cannot update revision with empty message'));
  }

  const stream = getArcanistServiceByNuclideUri(filePath)
    .updatePhabricatorRevision(filePath, userUpdateMessage, allowUntracked, lintExcuse)
    .refCount();

  return processArcanistOutput(stream)
    .startWith({level: 'log', text: `Updating revision \`${phabricatorRevision.name}\`...\n`})
    .do({
      next: message => publishUpdates.next(message),
      complete: () => notifyRevisionStatus(phabricatorRevision, 'updated'),
    }).ignoreElements();
}

function hgRepositoryForPath(filePath: NuclideUri): HgRepositoryClient {
  // Calling atom.project.repositoryForDirectory gets the real path of the directory,
  // which is another round-trip and calls the repository providers to get an existing repository.
  // Instead, the first match of the filtering here is the only possible match.
  const repository = repositoryForPath(filePath);
  if (repository == null || repository.getType() !== 'hg') {
    const type = repository ? repository.getType() : 'no repository';
    throw new Error(
      'Diff view only supports `Mercurial` repositories, ' +
      `but found \`${type}\` at path: \`${filePath}\``,
    );
  }
  return (repository: any);
}

function notifyRevisionStatus(
  phabRevision: ?PhabricatorRevisionInfo,
  statusMessage: string,
): void {
  let message = `Revision ${statusMessage}`;
  if (phabRevision == null) {
    atom.notifications.addSuccess(message, {nativeFriendly: true});
    return;
  }
  const {name, url} = phabRevision;
  message = `Revision '${name}' ${statusMessage}`;
  atom.notifications.addSuccess(message, {
    buttons: [{
      className: 'icon icon-globe',
      onDidClick() { shell.openExternal(url); },
      text: 'Open in Phabricator',
    }],
    nativeFriendly: true,
  });
}

export type State = {
  filePath: NuclideUri,
  oldContents: string,
  newContents: string,
  fromRevisionTitle: string,
  toRevisionTitle: string,
  compareRevisionInfo: ?RevisionInfo,
  inlineComponents?: Array<UIElement>,
  viewMode: DiffModeType,
  commitMessage: ?string,
  commitMode: CommitModeType,
  commitModeState: CommitModeStateType,
  shouldRebaseOnAmend: boolean,
  publishMessage: ?string,
  publishMode: PublishModeType,
  publishModeState: PublishModeStateType,
  headCommitMessage: ?string,
  dirtyFileChanges: Map<NuclideUri, FileChangeStatusValue>,
  selectedFileChanges: Map<NuclideUri, FileChangeStatusValue>,
  showNonHgRepos: boolean,
  revisionsState: ?RevisionsState,
};

export default class DiffViewModel {

  _emitter: Emitter;
  _subscriptions: CompositeDisposable;
  _activeSubscriptions: CompositeDisposable;
  _activeRepositoryStack: ?RepositoryStack;
  _uiProviders: Array<UIProvider>;
  _repositoryStacks: Map<HgRepositoryClient, RepositoryStack>;
  _repositorySubscriptions: Map<HgRepositoryClient, CompositeDisposable>;
  _isActive: boolean;
  _state: State;
  _publishUpdates: Subject<any>;
  _serializedUpdateActiveFileDiff: () => Promise<void>;
  _actionCreators: BoundActionCreators;
  _useReduxStore: boolean;

  constructor(actionCreators: BoundActionCreators, useReduxStore: boolean) {
    this._actionCreators = actionCreators;
    this._useReduxStore = useReduxStore;
    this._emitter = new Emitter();
    this._subscriptions = new CompositeDisposable();
    this._activeSubscriptions = new CompositeDisposable();
    this._uiProviders = [];
    this._repositoryStacks = new Map();
    this._repositorySubscriptions = new Map();
    this._isActive = false;
    this._publishUpdates = new Subject();
    this._state = getInitialState();
    this._serializedUpdateActiveFileDiff = serializeAsyncCall(
      () => this._updateActiveFileDiff(),
    );
    this._updateRepositories();
    this._subscriptions.add(atom.project.onDidChangePaths(this._updateRepositories.bind(this)));
  }

  _updateRepositories(): void {
    const repositories = new Set(
      atom.project.getRepositories().filter(
        repository => repository != null && repository.getType() === 'hg',
      ),
    );
    // Dispose removed projects repositories, if any.
    for (const [repository, repositoryStack] of this._repositoryStacks) {
      if (repositories.has(repository)) {
        continue;
      }
      if (this._activeRepositoryStack === repositoryStack) {
        this._activeRepositoryStack = null;
      }
      repositoryStack.dispose();
      this._repositoryStacks.delete(repository);
      const subscriptions = this._repositorySubscriptions.get(repository);
      invariant(subscriptions);
      subscriptions.dispose();
      this._repositorySubscriptions.delete(repository);
    }

    // Add the new project repositories, if any.
    for (const repository of repositories) {
      if (this._repositoryStacks.has(repository)) {
        continue;
      }
      const hgRepository = ((repository: any): HgRepositoryClient);
      this._createRepositoryStack(hgRepository);
    }

    // Update active repository stack, if needed.
    // This will make sure we have a repository stack active whenever we have
    // a mercurial repository added to the project.
    if (this._activeRepositoryStack == null && this._repositoryStacks.size > 0) {
      this._setActiveRepositoryStack(
        Array.from(this._repositoryStacks.values())[0],
      );
    }
    this._updateDirtyChangedStatus();
    this._updateSelectedFileChanges();
    // Clear the active diff state if it was from a repo that's now removed.
    const {filePath} = this._state;
    if (filePath && !repositories.has((repositoryForPath(filePath): any))) {
      getLogger().info(
        'Diff View\'s active buffer was belonging to a removed project.\n' +
        'Clearing the UI state.',
      );
      this._activeSubscriptions.dispose();
      this._setState({
        ...this._state,
        ...getInitialFileChangeState(),
      });
    }
  }

  _createRepositoryStack(repository: HgRepositoryClient): RepositoryStack {
    const repositoryStack = new RepositoryStack(
      repository,
      viewModeToDiffOption(this._state.viewMode),
    );
    const subscriptions = new CompositeDisposable();
    subscriptions.add(
      repositoryStack.onDidUpdateDirtyFileChanges(
        this._updateDirtyChangedStatus.bind(this),
      ),
      repositoryStack.onDidUpdateSelectedFileChanges(
        this._updateSelectedFileChanges.bind(this),
      ),
      repositoryStack.onDidChangeRevisionsState(() => {
        this._updateChangedRevisionsState(repositoryStack, true)
          .catch(notifyInternalError);
      }),
    );
    this._repositoryStacks.set(repository, repositoryStack);
    this._repositorySubscriptions.set(repository, subscriptions);
    if (this._isActive) {
      repositoryStack.activate();
    }
    return repositoryStack;
  }

  _updateDirtyChangedStatus(): void {
    const dirtyFileChanges = mapUnion(
      ...Array.from(this._repositoryStacks.values())
      .map(repositoryStack => repositoryStack.getDirtyFileChanges()),
    );
    this._updateViewChangedFilesStatus(dirtyFileChanges);
  }

  getActiveStackDirtyFileChanges(): Map<NuclideUri, FileChangeStatusValue> {
    if (this._activeRepositoryStack == null) {
      return new Map();
    } else {
      return this._activeRepositoryStack.getDirtyFileChanges();
    }
  }

  _updateSelectedFileChanges(): void {
    const selectedFileChanges = mapUnion(
      ...Array.from(this._repositoryStacks.values())
      .map(repositoryStack => repositoryStack.getSelectedFileChanges()),
    );
    this._updateViewChangedFilesStatus(
      null,
      selectedFileChanges,
    );
  }

  _updateViewChangedFilesStatus(
    dirtyFileChanges_?: ?Map<NuclideUri, FileChangeStatusValue>,
    selectedFileChanges_?: ?Map<NuclideUri, FileChangeStatusValue>,
  ): void {
    let dirtyFileChanges = dirtyFileChanges_;
    let selectedFileChanges = selectedFileChanges_;
    if (dirtyFileChanges == null) {
      dirtyFileChanges = this._state.dirtyFileChanges;
    }
    if (selectedFileChanges == null) {
      selectedFileChanges = this._state.selectedFileChanges;
    }
    let filteredFileChanges;
    let showNonHgRepos;
    let activeRepositorySelector = () => true;
    if (this._activeRepositoryStack != null) {
      const projectDirectory = this._activeRepositoryStack.getRepository().getProjectDirectory();
      activeRepositorySelector = (filePath: NuclideUri) =>
        nuclideUri.contains(projectDirectory, filePath);
    }
    switch (this._state.viewMode) {
      case DiffMode.COMMIT_MODE:
      case DiffMode.PUBLISH_MODE:
        // Commit mode only shows the changes of the active repository.
        filteredFileChanges = mapFilter(selectedFileChanges, activeRepositorySelector);
        // Publish mode only shows the changes of the active repository.
        filteredFileChanges = mapFilter(selectedFileChanges, activeRepositorySelector);
        showNonHgRepos = false;
        break;
      case DiffMode.BROWSE_MODE:
        // Broswe mode shows all changes from all repositories.
        filteredFileChanges = selectedFileChanges;
        showNonHgRepos = true;
        break;
      default:
        throw new Error('Unrecognized view mode!');
    }
    this._setState({
      ...this._state,
      dirtyFileChanges,
      selectedFileChanges: filteredFileChanges,
      showNonHgRepos,
    });
  }

  async _updateChangedRevisionsState(
    repositoryStack: RepositoryStack,
    reloadFileDiffState: boolean,
  ): Promise<void> {
    if (repositoryStack !== this._activeRepositoryStack) {
      return;
    }

    const revisionsState = await repositoryStack.getCachedRevisionsState();
    if (repositoryStack !== this._activeRepositoryStack) {
      return;
    }

    track('diff-view-update-timeline-revisions');
    this._setState({
      ...this._state,
      revisionsState,
    });
    this._loadModeState(true);

    // Update the active file, if changed.
    const {filePath} = this._state;
    if (!filePath || !reloadFileDiffState) {
      return;
    }
    this._serializedUpdateActiveFileDiff();
  }

  async _updateActiveFileDiff(): Promise<void> {
    const {filePath, commitMode, viewMode} = this._state;
    if (!filePath) {
      return;
    }
    // Capture the view state before the update starts.
    const {
      committedContents,
      filesystemContents,
      revisionInfo,
    } = await this._fetchFileDiff(filePath);
    if (
      this._state.filePath !== filePath ||
      this._state.viewMode !== viewMode ||
      this._state.commitMode !== commitMode
    ) {
      // The state have changed since the update started, and there must be another
      // scheduled update. Hence, we return early to allow it to go through.
      return;
    }
    await this._updateDiffStateIfChanged(
      filePath,
      committedContents,
      filesystemContents,
      revisionInfo,
    );
  }

  setPublishMessage(publishMessage: ?string): void {
    this._setState({
      ...this._state,
      publishMessage,
    });
  }

  setCommitMessage(commitMessage: string): void {
    this._setState({
      ...this._state,
      commitMessage,
    });
  }

  setViewMode(viewMode: DiffModeType, loadModeState?: boolean = true): void {
    this._actionCreators.setViewMode(viewMode);
    if (viewMode === this._state.viewMode) {
      return;
    }
    track('diff-view-switch-mode', {
      viewMode,
    });
    this._setState({
      ...this._state,
      viewMode,
    });
    if (this._activeRepositoryStack != null) {
      const repositoryStack = this._activeRepositoryStack;
      const diffOption = viewModeToDiffOption(this._state.viewMode);
      repositoryStack.setDiffOption(diffOption);
    }
    this._updateViewChangedFilesStatus();
    if (loadModeState) {
      this._loadModeState(false);
    }
    this._serializedUpdateActiveFileDiff();
  }

  _loadModeState(resetState: boolean): void {
    if (resetState) {
      this._setState({
        ...this._state,
        commitMessage: null,
        publishMessage: null,
      });
    }
    switch (this._state.viewMode) {
      case DiffMode.COMMIT_MODE:
        this._loadCommitModeState();
        break;
      case DiffMode.PUBLISH_MODE:
        this._loadPublishModeState().catch(notifyInternalError);
        break;
    }
  }

  _findFilePathToDiffInDirectory(directoryPath: NuclideUri): ?string {
    const repositoryStack = this._getRepositoryStackForPath(directoryPath);
    const hgRepository = repositoryStack.getRepository();
    const projectDirectory = hgRepository.getProjectDirectory();

    function getMatchingFileChange(
      filePaths: Array<NuclideUri>,
      parentPath: NuclideUri,
    ): ?NuclideUri {
      return filePaths.filter(filePath => nuclideUri.contains(parentPath, filePath))[0];
    }
    const dirtyFilePaths = Array.from(repositoryStack.getDirtyFileChanges().keys());
    // Try to match dirty file changes in the selected directory,
    // Then lookup for changes in the project directory.
    const matchedFilePaths = [
      getMatchingFileChange(dirtyFilePaths, directoryPath),
      getMatchingFileChange(dirtyFilePaths, projectDirectory),
    ];
    return matchedFilePaths[0] || matchedFilePaths[1];
  }

  diffEntity(entityOption: DiffEntityOptions): void {
    let diffPath = null;
    if (entityOption.file != null) {
      diffPath = entityOption.file;
    } else if (entityOption.directory != null) {
      diffPath = this._findFilePathToDiffInDirectory(entityOption.directory);
    }

    if (diffPath == null) {
      const repository = repositoryForPath(entityOption.file || entityOption.directory || '');
      if (
        repository != null &&
        repository.getType() === 'hg' &&
        this._repositoryStacks.has((repository: any))
      ) {
        const repositoryStack = this._repositoryStacks.get((repository: any));
        invariant(repositoryStack);
        this._setActiveRepositoryStack(repositoryStack);
      } else if (this._activeRepositoryStack == null) {
        // This can only happen none of the project folders are Mercurial repositories.
        // However, this is caught earlier with a better error message.
        throw new Error(
          'No active repository stack and non-diffable entity:' +
          JSON.stringify(entityOption),
        );
      } else {
        getLogger().error('Non diffable entity:', entityOption);
      }
    }
    const {viewMode, commitMode} = entityOption;
    if (viewMode !== this._state.viewMode || commitMode !== this._state.commitMode) {
      if (viewMode === DiffMode.COMMIT_MODE) {
        invariant(commitMode, 'DIFF: Commit Mode not set!');
        this.setViewMode(DiffMode.COMMIT_MODE, false);
        this.setCommitMode(commitMode, false);
        this._loadModeState(true);
      } else if (viewMode) {
        this.setViewMode(viewMode);
      }
    }
    if (diffPath != null) {
      // Diff the file after setting the view mode to compare against the right thing.
      this._diffFilePath(diffPath);
    }
  }

  _diffFilePath(filePath: NuclideUri): void {
    if (filePath === this._state.filePath) {
      return;
    }
    this._setState({
      ...this._state,
      ...getInitialFileChangeState(),
      filePath,
    });
    this._activeSubscriptions.dispose();
    this._activeSubscriptions = new CompositeDisposable();
    // TODO(most): Show progress indicator: t8991676
    const buffer = bufferForUri(filePath);
    this._activeSubscriptions.add(buffer.onDidReload(
      () => this._onActiveBufferReload(filePath, buffer).catch(notifyInternalError),
    ));
    this._activeSubscriptions.add(buffer.onDidDestroy(() => {
      getLogger().info(
        'Diff View\'s active buffer has been destroyed.\n' +
        'The underlying file could have been removed.',
      );
      this._activeSubscriptions.dispose();
      this._setState({
        ...this._state,
        ...getInitialFileChangeState(),
      });
    }));
    this._activeSubscriptions.add(buffer.onDidChangeModified(
      this.emitActiveBufferChangeModified.bind(this),
    ));
    // Modified events could be late that it doesn't capture the latest edits / state changes.
    // Hence, it's safe to re-emit changes when stable from changes.
    this._activeSubscriptions.add(buffer.onDidStopChanging(
      this.emitActiveBufferChangeModified.bind(this),
    ));
    track('diff-view-open-file', {filePath});
    this._updateActiveDiffState(filePath).catch(notifyInternalError);
  }

  async _onActiveBufferReload(filePath: NuclideUri, buffer: atom$TextBuffer): Promise<void> {
    const {
      oldContents: committedContents,
      compareRevisionInfo: revisionInfo,
    } = this._state;
    if (revisionInfo == null) {
      // The file could be just loaded.
      return;
    }
    await this._updateDiffStateIfChanged(
      filePath,
      committedContents,
      buffer.getText(),
      revisionInfo,
    );
  }

  emitActiveBufferChangeModified(): void {
    this._emitter.emit(ACTIVE_BUFFER_CHANGE_MODIFIED_EVENT);
  }

  onDidActiveBufferChangeModified(
    callback: () => mixed,
  ): IDisposable {
    return this._emitter.on(ACTIVE_BUFFER_CHANGE_MODIFIED_EVENT, callback);
  }

  isActiveBufferModified(): boolean {
    const {filePath} = this._state;
    const buffer = bufferForUri(filePath);
    return buffer.isModified();
  }

  async _updateDiffStateIfChanged(
    filePath: NuclideUri,
    committedContents: string,
    filesystemContents: string,
    revisionInfo: RevisionInfo,
  ): Promise<void> {
    if (this._state.filePath !== filePath) {
      return;
    }
    const updatedDiffState = {
      committedContents,
      filesystemContents,
      revisionInfo,
    };
    return this._updateDiffState(
      filePath,
      updatedDiffState,
    );
  }

  setNewContents(newContents: string): void {
    this._setState({
      ...this._state,
      newContents,
    });
  }

  setCompareRevision(revision: RevisionInfo): void {
    track('diff-view-set-revision');
    const repositoryStack = this._activeRepositoryStack;
    invariant(repositoryStack, 'There must be an active repository stack!');
    this._setState({
      ...this._state,
      compareRevisionInfo: revision,
    });
    repositoryStack.setCompareRevision(revision).catch(notifyInternalError);
    this._actionCreators.setCompareId(repositoryStack.getRepository(), revision.id);
  }

  getPublishUpdates(): Subject<any> {
    return this._publishUpdates;
  }

  async _updateActiveDiffState(filePath: NuclideUri): Promise<void> {
    if (!filePath) {
      return;
    }
    const fileDiffState = await this._fetchFileDiff(filePath);
    await this._updateDiffState(
      filePath,
      fileDiffState,
    );
  }

  async _updateDiffState(
    filePath: NuclideUri,
    fileDiffState: FileDiffState,
  ): Promise<void> {
    const {
      committedContents: oldContents,
      filesystemContents: newContents,
      revisionInfo,
    } = fileDiffState;
    this._setState({
      ...this._state,
      filePath,
      oldContents,
      newContents,
      compareRevisionInfo: revisionInfo,
      fromRevisionTitle: formatFileDiffRevisionTitle(revisionInfo),
      toRevisionTitle: 'Filesystem / Editor',
    });
    // TODO(most): Fix: this assumes that the editor contents aren't changed while
    // fetching the comments, that's okay now because we don't fetch them.
    await this._updateInlineComponents();
  }

  @trackTiming('diff-view.hg-state-update')
  async _fetchFileDiff(filePath: NuclideUri): Promise<FileDiffState> {
    const repositoryStack = this._getRepositoryStackForPath(filePath);
    const [hgDiff] = await Promise.all([
      repositoryStack.fetchHgDiff(filePath),
      this._setActiveRepositoryStack(repositoryStack),
    ]);
    // Intentionally fetch the filesystem contents after getting the committed contents
    // to make sure we have the latest filesystem version.
    const buffer = await loadBufferForUri(filePath);
    return {
      ...hgDiff,
      filesystemContents: buffer.getText(),
    };
  }

  _getRepositoryStackForPath(filePath: NuclideUri): RepositoryStack {
    const hgRepository = hgRepositoryForPath(filePath);
    const repositoryStack = this._repositoryStacks.get(hgRepository);
    invariant(repositoryStack, 'There must be an repository stack for a given repository!');
    return repositoryStack;
  }

  async _setActiveRepositoryStack(repositoryStack: RepositoryStack): Promise<void> {
    if (this._activeRepositoryStack === repositoryStack) {
      return;
    }
    this._activeRepositoryStack = repositoryStack;
    const diffOption = viewModeToDiffOption(this._state.viewMode);
    repositoryStack.setDiffOption(diffOption);
    if (!this._isActive) {
      return;
    }
    this._updateChangedRevisionsState(repositoryStack, false);
  }


  @trackTiming('diff-view.save-file')
  saveActiveFile(): Promise<void> {
    const {filePath} = this._state;
    track('diff-view-save-file', {filePath});
    return this._saveFile(filePath).catch(notifyInternalError);
  }

  @trackTiming('diff-view.publish-diff')
  async publishDiff(
    publishMessage: string,
    lintExcuse: ?string,
  ): Promise<void> {
    const activeStack = this._activeRepositoryStack;
    invariant(activeStack != null, 'Cannot publish without an active stack!');

    if (this._useReduxStore) {
      // The UI wouldn't update yet with that development config enabled
      // as it's still wired to the old model state.
      // TODO(most): Cleanup to use the redux store.
      this._actionCreators.publishDiff(
        activeStack.getRepository(),
        publishMessage,
        lintExcuse,
        this._publishUpdates,
      );
      return;
    }

    this._setState({
      ...this._state,
      publishMessage,
      publishModeState: PublishModeState.AWAITING_PUBLISH,
    });
    const {publishMode} = this._state;
    track('diff-view-publish', {
      publishMode,
    });
    const commitMessage = publishMode === PublishMode.CREATE ? publishMessage : null;
    let cleanResult;
    try {
      cleanResult = await promptToCleanDirtyChanges(
        activeStack.getRepository(),
        commitMessage,
        this._state.shouldRebaseOnAmend,
      );
    } catch (error) {
      atom.notifications.addError('Error clearning dirty changes', {
        detail: error.message,
        dismissable: true,
        nativeFriendly: true,
      });
    }
    if (cleanResult == null) {
      this._setState({
        ...this._state,
        publishModeState: PublishModeState.READY,
      });
      return;
    }
    const {amended, allowUntracked} = cleanResult;
    try {
      const headCommitMessage = await this._getActiveHeadCommitMessage();
      if (headCommitMessage == null) {
        throw new Error('Cannot Fetch Head Commit Message!');
      }

      switch (publishMode) {
        case PublishMode.CREATE:
          // Create uses `verbatim` and `n` answer buffer
          // and that implies that untracked files will be ignored.
          await createPhabricatorRevision(
            activeStack.getRepository(),
            this._publishUpdates,
            headCommitMessage,
            publishMessage,
            amended,
            lintExcuse,
          ).toPromise();
          break;
        case PublishMode.UPDATE:
          await updatePhabricatorRevision(
            activeStack.getRepository(),
            this._publishUpdates,
            headCommitMessage,
            publishMessage,
            allowUntracked,
            lintExcuse,
          ).toPromise();
          break;
        default:
          throw new Error(`Unknown publish mode '${publishMode}'`);
      }
      // Populate Publish UI with the most recent data after a successful push.
      this._setState({
        ...this._state,
        publishModeState: PublishModeState.READY,
      });
      this.setViewMode(DiffMode.BROWSE_MODE);
    } catch (error) {
      atom.notifications.addError('Couldn\'t Publish to Phabricator', {
        detail: error.message,
        nativeFriendly: true,
      });
      this._setState({
        ...this._state,
        publishModeState: PublishModeState.PUBLISH_ERROR,
      });
    }
  }

  _getArcanistFilePath(): string {
    let {filePath} = this._state;
    if (filePath === '' && this._activeRepositoryStack != null) {
      filePath = this._activeRepositoryStack.getRepository().getProjectDirectory();
    }
    return filePath;
  }

  async _saveFile(filePath: NuclideUri): Promise<void> {
    const buffer = bufferForUri(filePath);
    if (buffer == null) {
      throw new Error(`Could not find file buffer to save: \`${filePath}\``);
    }
    try {
      await buffer.save();
    } catch (err) {
      throw new Error(`Could not save file buffer: \`${filePath}\` - ${err.toString()}`);
    }
  }

  onDidUpdateState(callback: () => mixed): IDisposable {
    return this._emitter.on(DID_UPDATE_STATE_EVENT, callback);
  }

  async _updateInlineComponents(): Promise<void> {
    const {filePath} = this._state;
    if (!filePath) {
      return;
    }
    const inlineComponents = await this._fetchInlineComponents(filePath);
    if (filePath !== this._state.filePath) {
      return;
    }
    this._setState({
      ...this._state,
      inlineComponents,
    });
  }

  @trackTiming('diff-view.fetch-comments')
  async _fetchInlineComponents(filePath: NuclideUri): Promise<Array<UIElement>> {
    // TODO(most): Fix UI rendering and re-introduce: t8174332
    // provider.composeUiElements(filePath)
    const uiElementPromises = this._uiProviders.map(
      provider => Promise.resolve([]),
    );
    const uiComponentLists = await Promise.all(uiElementPromises);
    // Flatten uiComponentLists from list of lists of components to a list of components.
    const uiComponents = [].concat.apply([], uiComponentLists);
    return uiComponents;
  }

  setUiProviders(uiProviders: Array<UIProvider>): void {
    this._uiProviders = uiProviders;
    this._updateInlineComponents().catch(notifyInternalError);
  }

  async _loadCommitModeState(): Promise<void> {
    this._setState({
      ...this._state,
      commitModeState: CommitModeState.LOADING_COMMIT_MESSAGE,
    });

    let commitMessage = null;
    try {
      if (this._state.commitMessage != null) {
        commitMessage = this._state.commitMessage;
      } else if (this._state.commitMode === CommitMode.COMMIT) {
        commitMessage = await this._loadActiveRepositoryTemplateCommitMessage();
      } else {
        commitMessage = await this._loadActiveRepositoryLatestCommitMessage();
      }
    } catch (error) {
      notifyInternalError(error);
    } finally {
      this._setState({
        ...this._state,
        commitMessage,
        commitModeState: CommitModeState.READY,
      });
    }
  }

  async _loadPublishModeState(): Promise<void> {
    if (this._state.publishModeState === PublishModeState.AWAITING_PUBLISH) {
      // That must be an a update triggered by an `amend` operation,
      // done as part of diffing.
      return;
    }
    let publishMessage = this._state.publishMessage;
    this._setState({
      ...this._state,
      publishMode: PublishMode.CREATE,
      publishModeState: PublishModeState.LOADING_PUBLISH_MESSAGE,
      publishMessage: null,
      headCommitMessage: null,
    });
    const {headCommitMessage, phabricatorRevision} = await this._getActiveHeadCommitDetails();
    if (publishMessage == null || publishMessage.length === 0) {
      publishMessage = phabricatorRevision != null
        ? getRevisionUpdateMessage(phabricatorRevision)
        : headCommitMessage;
    }
    this._setState({
      ...this._state,
      publishMode: phabricatorRevision != null ? PublishMode.UPDATE : PublishMode.CREATE,
      publishModeState: PublishModeState.READY,
      publishMessage,
      headCommitMessage,
    });
  }

  async _getActiveHeadCommitDetails(): Promise<{
    headCommitMessage: string,
    phabricatorRevision: ?PhabricatorRevisionInfo,
  }> {
    const headCommitMessage = await this._getActiveHeadCommitMessage();
    if (headCommitMessage == null) {
      throw new Error('Cannot Fetch Head Commit Message!');
    }
    const phabricatorRevision = getPhabricatorRevisionFromCommitMessage(
      headCommitMessage,
    );
    return {
      headCommitMessage,
      phabricatorRevision,
    };
  }

  async _loadActiveRepositoryLatestCommitMessage(): Promise<string> {
    if (this._activeRepositoryStack == null) {
      throw new Error('Diff View: No active file or repository open');
    }
    const headCommitMessage = await this._getActiveHeadCommitMessage();
    invariant(headCommitMessage, 'Diff View Internal Error: head commit message cannot be null');
    return headCommitMessage;
  }

  async _loadActiveRepositoryTemplateCommitMessage(): Promise<?string> {
    if (this._activeRepositoryStack == null) {
      throw new Error('Diff View: No active file or repository open');
    }
    let commitMessage = await this._activeRepositoryStack
      .getRepository()
      .getTemplateCommitMessage();
    // Commit templates that include newline strings, '\\n' in JavaScript, need to convert their
    // strings to literal newlines, '\n' in JavaScript, to be rendered as line breaks.
    if (commitMessage != null) {
      commitMessage = convertNewlines(commitMessage);
    }
    return commitMessage;
  }

  async _getActiveHeadCommitMessage(): Promise<?string> {
    if (this._activeRepositoryStack == null || !this._isActive) {
      return null;
    }
    return await this._activeRepositoryStack.getRepository().async.getHeadCommitMessage();
  }

  _setState(newState: State) {
    this._state = newState;
    this._emitter.emit(DID_UPDATE_STATE_EVENT);
  }

  @trackTiming('diff-view.commit')
  async commit(message: string): Promise<void> {
    if (message === '') {
      atom.notifications.addError('Commit aborted', {detail: 'Commit message empty'});
      return;
    }

    const activeStack = this._activeRepositoryStack;
    invariant(activeStack != null, 'No active repository stack');

    if (this._useReduxStore) {
      // The UI wouldn't update yet with that development config enabled
      // as it's still wired to the old model state.
      // TODO(most): Cleanup to use thew redux store.
      this._actionCreators.commit(activeStack.getRepository(), message);
      return;
    }


    this._setState({
      ...this._state,
      commitMessage: message,
      commitModeState: CommitModeState.AWAITING_COMMIT,
    });

    const {commitMode} = this._state;
    track('diff-view-commit', {
      commitMode,
    });

    try {
      switch (commitMode) {
        case CommitMode.COMMIT:
          await activeStack.getRepository()
            .commit(message)
            .toArray().toPromise();
          atom.notifications.addSuccess('Commit created', {nativeFriendly: true});
          break;
        case CommitMode.AMEND:
          await activeStack.getRepository()
            .amend(message, getAmendMode(this._state.shouldRebaseOnAmend))
            .toArray().toPromise();
          atom.notifications.addSuccess('Commit amended', {nativeFriendly: true});
          break;
      }

      // Refresh revisions state to update the UI with the new commit info.
      activeStack.refreshRevisionsState();
      this.setViewMode(DiffMode.BROWSE_MODE);
    } catch (e) {
      atom.notifications.addError('Error creating commit', {
        detail: `Details: ${e.message}`,
        nativeFriendly: true,
      });
      this._setState({
        ...this._state,
        commitModeState: CommitModeState.READY,
      });
      return;
    }
  }

  getState(): State {
    return this._state;
  }

  setCommitMode(commitMode: CommitModeType, loadModeState?: boolean = true): void {
    this._actionCreators.setCommitMode(commitMode);
    if (this._state.commitMode === commitMode) {
      return;
    }
    track('diff-view-switch-commit-mode', {
      commitMode,
    });
    this._setState({
      ...this._state,
      commitMode,
      commitMessage: null,
    });
    if (loadModeState) {
      // When the commit mode changes, load the appropriate commit message.
      this._loadModeState(true);
    }
  }

  setShouldAmendRebase(shouldRebaseOnAmend: boolean): void {
    this._actionCreators.setShouldRebaseOnAmend(shouldRebaseOnAmend);
    this._setState({
      ...this._state,
      shouldRebaseOnAmend,
    });
  }

  activate(): void {
    this._updateRepositories();
    this._isActive = true;
    for (const [repository, repositoryStack] of this._repositoryStacks.entries()) {
      repositoryStack.activate();
      // TODO(most): Consider activating only the visible repository.
      this._actionCreators.activateRepository(repository);
    }
  }

  deactivate(): void {
    this._isActive = false;
    for (const [repository, repositoryStack] of this._repositoryStacks.entries()) {
      repositoryStack.deactivate();
      this._actionCreators.deactivateRepository(repository);
    }
    this._activeRepositoryStack = null;
    this._setState({
      ...this._state,
      ...getInitialFileChangeState(),
    });
    this._activeSubscriptions.dispose();
  }

  dispose(): void {
    this._subscriptions.dispose();
    for (const repositoryStack of this._repositoryStacks.values()) {
      repositoryStack.dispose();
    }
    this._repositoryStacks.clear();
    for (const subscription of this._repositorySubscriptions.values()) {
      subscription.dispose();
    }
    this._repositorySubscriptions.clear();
    this._activeSubscriptions.dispose();
  }
}
