use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

pub const MAX_IN_FLIGHT_TOOLS: usize = 16;
pub const MAX_IN_FLIGHT_SHELL: usize = 4;
pub const MAX_IN_FLIGHT_READS: usize = 8;
pub const MAX_IN_FLIGHT_MUTATIONS: usize = 2;
pub const MAX_IN_FLIGHT_MUTATIONS_PER_SESSION: usize = 1;
pub const MAX_IN_FLIGHT_PLUGINS: usize = 4;
pub const MAX_IN_FLIGHT_PER_SESSION: usize = 4;
pub const MAX_QUEUED_TOOLS: usize = 64;
/// How long a call waits for its class permit before admission fails. A call
/// waits here after the permission gate and before it runs, so the transport
/// deadline has to carry it too. Mirrored by `TOOL_QUEUE_WAIT_MS` in
/// `packages/shared/src/rpc-timeouts.ts`.
pub const TOOL_QUEUE_WAIT_MS: u64 = 30_000;
const QUEUE_WAIT: Duration = Duration::from_millis(TOOL_QUEUE_WAIT_MS);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolClass {
    Read,
    Mutation,
    Shell,
    Plugin,
}

impl ToolClass {
    fn from_name(tool_name: &str) -> Self {
        match tool_name {
            "Read" | "Glob" | "Grep" => Self::Read,
            "Write" | "Edit" => Self::Mutation,
            "Bash" => Self::Shell,
            _ => Self::Plugin,
        }
    }
}

#[derive(Debug)]
pub enum AdmissionError {
    QueueFull { queue_depth: usize },
    QueueWaitTimeout,
}

impl AdmissionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::QueueFull { .. } | Self::QueueWaitTimeout => "HOST_OVERLOADED",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::QueueFull { queue_depth } => format!(
                "host tool capacity is exhausted; bounded queue is full ({queue_depth} queued)"
            ),
            Self::QueueWaitTimeout => "host tool capacity did not become available in time".into(),
        }
    }
}

pub struct ToolPermit {
    _total: OwnedSemaphorePermit,
    _class: OwnedSemaphorePermit,
    _session: OwnedSemaphorePermit,
    _session_mutation: Option<OwnedSemaphorePermit>,
    _workspace_mutation: Option<OwnedMutexGuard<()>>,
}

#[derive(Clone, Default)]
pub struct WorkspaceMutationLocks {
    locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl WorkspaceMutationLocks {
    async fn lock_for(&self, root: &Path) -> Arc<Mutex<()>> {
        let key = crate::workspace::simple_canonicalize(root)
            .unwrap_or_else(|_| root.to_path_buf())
            .to_string_lossy()
            .to_string();
        let mut locks = self.locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    }

    pub(crate) async fn acquire(&self, root: &Path) -> Result<OwnedMutexGuard<()>, AdmissionError> {
        tokio::time::timeout(QUEUE_WAIT, self.lock_for(root).await.lock_owned())
            .await
            .map_err(|_| AdmissionError::QueueWaitTimeout)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ToolBudgetSnapshot {
    pub active: usize,
    pub queued: usize,
    pub total: usize,
    pub shell: usize,
    pub reads: usize,
    pub mutations: usize,
    pub plugins: usize,
}

#[derive(Clone)]
pub struct ToolBudget {
    total: Arc<Semaphore>,
    reads: Arc<Semaphore>,
    mutations: Arc<Semaphore>,
    shell: Arc<Semaphore>,
    plugins: Arc<Semaphore>,
    sessions: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    session_mutations: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    queued: Arc<AtomicUsize>,
}

impl ToolBudget {
    pub fn new() -> Self {
        Self {
            total: Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOLS)),
            reads: Arc::new(Semaphore::new(MAX_IN_FLIGHT_READS)),
            mutations: Arc::new(Semaphore::new(MAX_IN_FLIGHT_MUTATIONS)),
            shell: Arc::new(Semaphore::new(MAX_IN_FLIGHT_SHELL)),
            plugins: Arc::new(Semaphore::new(MAX_IN_FLIGHT_PLUGINS)),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_mutations: Arc::new(Mutex::new(HashMap::new())),
            queued: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn acquire(
        &self,
        session_id: &str,
        tool_name: &str,
        workspace_root: Option<&Path>,
        workspace_locks: &WorkspaceMutationLocks,
    ) -> Result<ToolPermit, AdmissionError> {
        let class = ToolClass::from_name(tool_name);
        let workspace_mutation = if matches!(class, ToolClass::Mutation | ToolClass::Shell) {
            match workspace_root {
                Some(root) => Some(workspace_locks.acquire(root).await?),
                None => None,
            }
        } else {
            None
        };
        let class_semaphore = self.class_semaphore(class);
        let session_semaphore = self.session_semaphore(session_id).await;
        let session_mutation_semaphore = match class {
            ToolClass::Mutation => Some(self.session_mutation_semaphore(session_id).await),
            _ => None,
        };

        if let Some(mut permit) = Self::try_acquire(
            self.total.clone(),
            class_semaphore.clone(),
            session_semaphore.clone(),
            session_mutation_semaphore.clone(),
        ) {
            permit._workspace_mutation = workspace_mutation;
            return Ok(permit);
        }

        let queue_depth = self.queued.fetch_add(1, Ordering::SeqCst) + 1;
        if queue_depth > MAX_QUEUED_TOOLS {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            return Err(AdmissionError::QueueFull { queue_depth });
        }

        let result = tokio::time::timeout(
            QUEUE_WAIT,
            Self::acquire_all(
                self.total.clone(),
                class_semaphore,
                session_semaphore,
                session_mutation_semaphore,
            ),
        )
        .await;
        self.queued.fetch_sub(1, Ordering::SeqCst);

        match result {
            Ok(mut permit) => {
                permit._workspace_mutation = workspace_mutation;
                Ok(permit)
            }
            Err(_) => Err(AdmissionError::QueueWaitTimeout),
        }
    }

    pub fn snapshot(&self) -> ToolBudgetSnapshot {
        let active = MAX_IN_FLIGHT_TOOLS - self.total.available_permits();
        ToolBudgetSnapshot {
            active,
            queued: self.queued.load(Ordering::SeqCst),
            total: MAX_IN_FLIGHT_TOOLS,
            shell: MAX_IN_FLIGHT_SHELL - self.shell.available_permits(),
            reads: MAX_IN_FLIGHT_READS - self.reads.available_permits(),
            mutations: MAX_IN_FLIGHT_MUTATIONS - self.mutations.available_permits(),
            plugins: MAX_IN_FLIGHT_PLUGINS - self.plugins.available_permits(),
        }
    }

    fn class_semaphore(&self, class: ToolClass) -> Arc<Semaphore> {
        match class {
            ToolClass::Read => self.reads.clone(),
            ToolClass::Mutation => self.mutations.clone(),
            ToolClass::Shell => self.shell.clone(),
            ToolClass::Plugin => self.plugins.clone(),
        }
    }

    async fn session_semaphore(&self, session_id: &str) -> Arc<Semaphore> {
        let mut sessions = self.sessions.lock().await;
        sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT_PER_SESSION)))
            .clone()
    }

    async fn session_mutation_semaphore(&self, session_id: &str) -> Arc<Semaphore> {
        let mut sessions = self.session_mutations.lock().await;
        sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT_MUTATIONS_PER_SESSION)))
            .clone()
    }

    fn try_acquire(
        total: Arc<Semaphore>,
        class: Arc<Semaphore>,
        session: Arc<Semaphore>,
        session_mutation: Option<Arc<Semaphore>>,
    ) -> Option<ToolPermit> {
        let session_mutation_permit = match session_mutation {
            Some(semaphore) => Some(semaphore.try_acquire_owned().ok()?),
            None => None,
        };
        let total_permit = total.try_acquire_owned().ok()?;
        let class_permit = class.try_acquire_owned().ok()?;
        let session_permit = session.try_acquire_owned().ok()?;
        Some(ToolPermit {
            _total: total_permit,
            _class: class_permit,
            _session: session_permit,
            _session_mutation: session_mutation_permit,
            _workspace_mutation: None,
        })
    }

    async fn acquire_all(
        total: Arc<Semaphore>,
        class: Arc<Semaphore>,
        session: Arc<Semaphore>,
        session_mutation: Option<Arc<Semaphore>>,
    ) -> ToolPermit {
        let session_mutation_permit = match session_mutation {
            Some(semaphore) => Some(
                semaphore
                    .acquire_owned()
                    .await
                    .expect("session mutation semaphore cannot be closed"),
            ),
            None => None,
        };
        let total_permit = total
            .acquire_owned()
            .await
            .expect("tool total semaphore cannot be closed");
        let class_permit = class
            .acquire_owned()
            .await
            .expect("tool class semaphore cannot be closed");
        let session_permit = session
            .acquire_owned()
            .await
            .expect("tool session semaphore cannot be closed");
        ToolPermit {
            _total: total_permit,
            _class: class_permit,
            _session: session_permit,
            _session_mutation: session_mutation_permit,
            _workspace_mutation: None,
        }
    }
}

impl Default for ToolBudget {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{ToolBudget, WorkspaceMutationLocks};
    use std::path::Path;
    use std::time::Duration;

    #[tokio::test]
    async fn limits_shell_concurrency_and_reports_active_work() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let mut permits = Vec::new();
        for index in 0..4 {
            permits.push(
                budget
                    .acquire(&format!("session-{index}"), "Bash", None, &locks)
                    .await
                    .unwrap(),
            );
        }
        let snapshot = budget.snapshot();
        assert_eq!(snapshot.active, 4);
        assert_eq!(snapshot.shell, 4);
        let waiting_budget = budget.clone();
        let waiting_locks = locks.clone();
        let waiter = tokio::spawn(async move {
            waiting_budget
                .acquire("session-waiter", "Bash", None, &waiting_locks)
                .await
        });
        drop(permits);
        assert!(waiter.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn separates_session_capacity() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let mut first = Vec::new();
        for _ in 0..4 {
            first.push(
                budget
                    .acquire("session-a", "Read", None, &locks)
                    .await
                    .unwrap(),
            );
        }
        assert!(budget
            .acquire("session-b", "Read", None, &locks)
            .await
            .is_ok());
        drop(first);
    }

    #[tokio::test]
    async fn serializes_mutations_within_a_session() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let first = budget
            .acquire("session-a", "Edit", None, &locks)
            .await
            .unwrap();
        let mut waiter = tokio::spawn({
            let budget = budget.clone();
            let locks = locks.clone();
            async move { budget.acquire("session-a", "Write", None, &locks).await }
        });
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut waiter)
            .await
            .is_err());
        drop(first);
        assert!(tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
            .is_ok());
    }

    #[tokio::test]
    async fn serializes_same_workspace_across_sessions_but_not_other_workspaces() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let first = budget
            .acquire("session-a", "Bash", Some(Path::new("shared")), &locks)
            .await
            .unwrap();
        let mut same = tokio::spawn({
            let budget = budget.clone();
            let locks = locks.clone();
            async move {
                budget
                    .acquire("session-b", "Write", Some(Path::new("shared")), &locks)
                    .await
            }
        });
        assert!(budget
            .acquire("session-c", "Edit", Some(Path::new("other")), &locks)
            .await
            .is_ok());
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut same)
            .await
            .is_err());
        drop(first);
        assert!(tokio::time::timeout(Duration::from_secs(1), same)
            .await
            .unwrap()
            .unwrap()
            .is_ok());
    }
}
