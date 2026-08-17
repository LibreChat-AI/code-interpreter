# Programmatic Tool Calling - Robustness Improvements

## Changes Implemented

### 1. ✅ Redis-Based Execution State (Multi-Instance Safe)

**Before:**

```typescript
const activeExecutions = new Map<string, {...}>(); // In-memory only!
```

**After:**

```typescript
// Redis keys: exec_state:{execution_id}
interface ExecutionState {
    execution_id: string;
    session_id: string;
    userId: string;
    apiKeyId: string;
    startTime: number;
    jobCompleted?: boolean;
    jobResult?: t.ExecuteResult;
    jobError?: string;
}
```

**Benefits:**

- ✅ Works with multiple service instances (horizontal scaling)
- ✅ Survives service restarts (state persists in Redis)
- ✅ Automatic expiry with TTL (10 minutes)
- ✅ No memory leaks

---

### 2. ✅ Automatic Cleanup of Stale Executions

**Background job runs every 5 minutes:**

```typescript
setInterval(
    () => {
        cleanupStaleExecutions(); // Finds executions older than TTL
    },
    5 * 60 * 1000,
);
```

**What it does:**

- Scans all `exec_state:*` keys in Redis
- Finds executions older than 10 minutes that aren't completed
- Cleans up Tool Call Server sessions
- Removes execution state from Redis

**Prevents:**

- Abandoned executions consuming resources
- Memory leaks in Tool Call Server
- Redis key accumulation

---

### 3. ✅ Retry Logic for Tool Call Server Communication

**All Tool Call Server requests now have automatic retry with exponential backoff:**

```typescript
async function retryToolCallServerRequest<T>(
    requestFn: () => Promise<T>,
    context: string,
): Promise<T> {
    // 3 attempts
    // Delays: 1s, 2s (exponential backoff)
    // Skips retry on 4xx errors (client errors)
}
```

**Applied to:**

- ✅ `POST /sessions` (create session)
- ✅ `GET /sessions/:id/pending` (get pending calls)
- ✅ `POST /sessions/:id/results` (submit results)
- ✅ `GET /sessions/:id/status` (get status)

**Handles:**

- Temporary network issues
- Tool Call Server momentary unavailability
- Redis connection hiccups

---

### 4. ✅ Improved Client Disconnect Handling

**When client disconnects mid-execution:**

```typescript
req.on('close', async () => {
    // 1. Remove job from queue (if not started)
    await job.remove();

    // 2. Cleanup execution state in Redis
    // 3. Cleanup Tool Call Server session
    await cleanupExecution(execution_id);
});
```

**Prevents:**

- Zombie executions running after client leaves
- Tool Call Server sessions lingering
- Wasted compute resources

---

### 5. ✅ Unified Cleanup Function

**Centralized cleanup logic:**

```typescript
async function cleanupExecution(execution_id: string): Promise<void> {
    await Promise.all([
        deleteExecutionState(execution_id),
        axios.delete(`${env.TOOL_CALL_SERVER_URL}/sessions/${execution_id}`),
    ]);
}
```

**Used in:**

- Client disconnect handler
- Completion handler
- Error handlers
- Stale execution cleanup

---

## Configuration

### Environment Variables

```bash
# Execution state TTL (in seconds)
# Default: 600 (10 minutes)
EXECUTION_STATE_TTL=600

# Tool Call Server retry settings
TOOL_CALL_SERVER_RETRY_ATTEMPTS=3
TOOL_CALL_SERVER_RETRY_DELAY=1000  # milliseconds
```

### Constants

```typescript
const POLL_INTERVAL = 100; // ms - How often to poll for state changes
const MAX_POLL_TIME = 300000; // ms - Max time to wait for execution
const EXECUTION_STATE_TTL = 600; // seconds - Redis key TTL
```

---

## Error Handling Improvements

### 1. Network Errors

- **Retry** up to 3 times with exponential backoff
- **Log** each attempt for debugging
- **Fail gracefully** if all attempts exhausted

### 2. Client Errors (4xx)

- **No retry** - these are permanent failures
- **Immediate cleanup** - free resources quickly
- **Detailed logging** - capture error details

### 3. Timeout Errors

- **Proper cleanup** - ensure no dangling state
- **Clear error messages** - help debugging
- **State preservation** - partial output saved

### 4. Tool Call Server Unavailable

- **Retry on 5xx errors** - might be temporary
- **Fallback to cleanup** - if all retries fail
- **Service degradation** - return 503 to client

---

## Monitoring & Observability

### Key Metrics to Track

1. **Execution count**

    ```typescript
    // Count active executions
    const keys = await connection.keys('exec_state:*');
    const activeCount = keys.length;
    ```

2. **Average execution time**

    ```typescript
    // Track in ExecutionState
    const duration = Date.now() - state.startTime;
    ```

3. **Cleanup stats**

    ```typescript
    logger.info('Cleanup completed', {
        stale_cleaned: cleaned,
        active_remaining: activeCount,
    });
    ```

4. **Retry rates**
    ```typescript
    logger.warn('Tool Call Server retry', {
        attempt,
        context,
        error: lastError.message,
    });
    ```

### Log Search Queries

```bash
# Find stale executions
grep "Cleaning up stale execution" logs/combined-*.log

# Find retry attempts
grep "failed (attempt" logs/combined-*.log

# Find client disconnects
grep "Client disconnected for execution" logs/combined-*.log

# Find cleanup failures
grep "Error during execution cleanup" logs/error-*.log
```

---

## Testing Robustness

### Test 1: Service Restart During Execution

```bash
# Start execution
./test-programmatic.sh simple &

# Restart service mid-execution
docker-compose restart service

# Should: Resume from Redis state or fail gracefully
```

### Test 2: Client Disconnect

```bash
# Start execution and kill immediately
timeout 2s ./test-programmatic.sh simple || true

# Should: Clean up execution state and Tool Call Server session
# Verify: Check Redis for leftover keys
redis-cli keys "exec_state:*"
```

### Test 3: Tool Call Server Unavailable

```bash
# Stop Tool Call Server
docker-compose stop tool_call_server

# Try execution (should fail gracefully)
./test-programmatic.sh simple

# Should: Return 503 error after retries
```

### Test 4: Stale Execution Cleanup

```bash
# Manually create stale execution state
redis-cli SET "exec_state:test_old" '{"execution_id":"test_old","startTime":0}'

# Wait 5+ minutes or trigger cleanup manually
# Should: Cleanup job removes stale state
```

---

## Future Enhancements

### 1. Pub/Sub Instead of Polling

Replace polling loop with Redis pub/sub for instant notification:

```typescript
// Instead of:
while (...) { await redis.get(...); await sleep(100); }

// Use:
await redis.subscribe(`exec:${execution_id}:complete`);
```

### 2. Health Checks

Add health check endpoint to verify all dependencies:

```typescript
GET /v1/exec/programmatic/health
{
  "redis": true,
  "tool_call_server": true,
  "sandbox": true,
  "active_executions": 5
}
```

### 3. Circuit Breaker

If Tool Call Server fails repeatedly, stop sending requests temporarily:

```typescript
const circuitBreaker = new CircuitBreaker(toolCallServerRequest, {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
});
```

### 4. Graceful Degradation

If Tool Call Server is down, queue executions for retry:

```typescript
if (toolCallServerDown) {
    await queueForRetry(execution_id, payload);
    return res.status(202).json({ message: 'Queued for execution' });
}
```

---

## Summary

| Improvement                | Status | Benefit                     |
| -------------------------- | ------ | --------------------------- |
| Redis-based state          | ✅     | Multi-instance scaling      |
| Stale execution cleanup    | ✅     | Prevents resource leaks     |
| Retry logic                | ✅     | Handles transient failures  |
| Client disconnect handling | ✅     | Immediate resource cleanup  |
| Unified cleanup function   | ✅     | Consistent state management |

The system is now production-ready for handling failures, scaling, and resource management.
