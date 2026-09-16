# Projects and worktrees

The intended experience is to select a project on an attached machine, choose
the current checkout or a new worktree, and have subsequent tool calls and
approval resumes use that selection without repeating a working directory.

## Delivery sequence

1. Local project inventory (`librechat-code projects --root <directory>`).
   Discover bounded Git metadata without changing registration or authority.
2. Negotiated project selection across the worker, Code API, and LibreChat.
   Persist the selection and enforce the same project boundary in file tools,
   commands, programmatic execution, environment actions, and approval resumes.
3. Worktree creation and setup with durable operation receipts. Publish a new
   selection only after Git creation, setup, and registration have completed.
4. Worktree selection in the composer and an approved agent operation. Allow
   an authenticated owner to narrow a selection to a newly created worktree
   with a compare-and-set against the prior conversation decision.
5. Explicit listing and removal, with binding checks and recovery for uncertain
   outcomes. Retention policy determines eligibility, not automatic permission
   to destroy uncommitted work or unpublished commits.

Only the first step is implemented by the inventory command. Existing explicit
workspace registration remains available for independent project directories.

## Boundaries that must remain consistent

-   Discovery metadata is advisory. A remote is not an authorization grant, a
    trusted repository identity, or automatically a codegraph repository ID.
    Keep the host in normalized remotes to distinguish identically named repos.
-   A discovery root may authorize enumeration while an execution root narrows
    writes to one selected project. A broad parent must not remain an independent
    concurrent execution lane alongside its descendants.
-   Path-derived IDs must be scoped by the registered root. Admission must
    validate the current directory identity; inventory cannot reserve a path
    against replacement after discovery.
-   Discovery must not run on every status request. A future worker catalog
    needs bounded caching, coalesced refreshes, and explicit generation changes.
-   A linked worktree shares Git metadata with its parent. Project IDs alone
    cannot make those metadata mutations independent. Admission needs both a
    filesystem boundary and coordination for the common Git directory.
-   A worktree beneath its parent checkout overlaps that checkout. Either use
    disjoint execution roots under a discovery grant or explicitly exclude and
    coordinate descendant worktrees before relaxing root exclusion.
-   Setup and dependency links must remain within the execution policy. Sharing
    writable dependency directories between supposedly isolated worktrees
    reintroduces overlap and requires an explicit operator decision.
-   Dynamic registration requires versioned capabilities and fenced catalog
    generations. Old consumers must not silently drop a project selection and
    execute against its broader parent. Deploy consumers before producers.
-   Create, setup, registration, and conversation binding form a recoverable
    lifecycle. A network retry must find the same worktree, not create a second
    one. Failed setup leaves it unavailable; uncertain mutation quarantines it.
-   Approval decisions must include the exact target and operation. Creating a
    branch changes repository state and follows mutation policy. An additive
    operation is not automatically exempt from required approval.
-   Cleanup must coordinate live bindings and active execution. A missing remote
    branch alone does not prove a worktree is disposable.

## Acceptance cases for selection and lifecycle

Verify separate repositories under one discovery root, two chats sharing one
project, two worktrees sharing Git metadata, directory replacement, stale
catalog generations, old/new consumer combinations, and cross-principal access.
Exercise file tools, commands, programmatic execution, and environment actions
through the same persisted selection. Include pause/resume, cancellation during
creation and setup, process death before registration, retry after binding, and
removal racing an active conversation. Use disposable local fixtures before
testing the hosted deployment.
