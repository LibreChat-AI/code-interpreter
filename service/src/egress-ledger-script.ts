/** One-key transactions work on Redis Cluster and serialize admission with revocation.
 * Legacy JSON is retained for mixed-version rollout; compact hashes avoid decoding
 * the immutable input policy on the hot path. Never retry an ambiguous EVAL result:
 * the operation may already have consumed its budget. */
export const EGRESS_LEDGER_SCRIPT = `
local key = KEYS[1]
local op = ARGV[1]
local kind = redis.call('TYPE', key)
if type(kind) == 'table' then kind = kind.ok end
local now = tonumber(ARGV[3])
local function denied(message) return {'error', 'scope_mismatch', message} end
if op == 'create' then
  if kind ~= 'none' then return {'ok'} end
  local policy = cjson.decode(ARGV[4])
  if ARGV[5] == 'compact' then
    redis.call('HSET', key, 'policy', ARGV[4], 'status', 'active',
      'exec_id', policy.exec_id, 'exp', policy.exp,
      'max_requests', policy.max_requests, 'max_upload_bytes', policy.max_upload_bytes,
      'max_output_files', policy.max_output_files,
      'request_count', 0, 'read_count', 0, 'upload_count', 0, 'tool_call_count', 0, 'uploaded_bytes', 0)
  else
    redis.call('SET', key, ARGV[4])
  end
  redis.call('EXPIRE', key, tonumber(ARGV[6]))
  return {'ok'}
end
if kind == 'none' then
  if op == 'revoke' then return {'ok'} end
  return denied('Egress grant ledger record is missing')
end
if kind ~= 'hash' and kind ~= 'string' then return denied('Invalid egress ledger representation') end
local compact = kind == 'hash'
local record = nil
if not compact then record = cjson.decode(redis.call('GET', key)) end
local function get(field)
  if compact then return redis.call('HGET', key, field) end
  return record[field]
end
local function number(field) return tonumber(get(field)) end
local function put(field, value)
  if compact then redis.call('HSET', key, field, value) else record[field] = value end
end
local function add(field, value)
  if compact then redis.call('HINCRBY', key, field, value) else record[field] = record[field] + value end
end
local function encodeRecord(value)
  local encoded = cjson.encode(value)
  -- Preserve the array contract for old gateways when cjson sees empty lists.
  for _, field in ipairs({'input_files', 'read_sessions', 'output_file_ids'}) do
    encoded = string.gsub(encoded, '"' .. field .. '":{}', '"' .. field .. '":[]')
  end
  return encoded
end
local function save()
  if not compact then
    -- Keep the original expiration, including a revocation tombstone's lifetime.
    local ttl = redis.call('PTTL', key)
    redis.call('SET', key, encodeRecord(record))
    if ttl >= 0 then redis.call('PEXPIRE', key, math.max(1, ttl)) end
  end
end
if op == 'revoke' then
  put('status', 'revoked')
  put('revoked_at', now)
  put('revoke_reason', ARGV[4])
  save()
  return {'ok'}
end
if get('exec_id') ~= ARGV[2] then return denied('Egress grant ledger record does not match token') end
if get('status') ~= 'active' then return denied('Egress grant has been revoked') end
if number('exp') <= now then return {'error', 'expired', 'Egress grant is expired'} end
if op == 'check' then return {'ok'} end
if op == 'snapshot' then
  if compact then
    record = cjson.decode(redis.call('HGET', key, 'policy'))
    for _, field in ipairs({'request_count', 'read_count', 'upload_count', 'tool_call_count', 'uploaded_bytes'}) do
      record[field] = number(field)
    end
    record.output_file_ids = {}
    local fields = redis.call('HKEYS', key)
    for _, field in ipairs(fields) do
      if string.sub(field, 1, 7) == 'output:' then table.insert(record.output_file_ids, string.sub(field, 8)) end
    end
  end
  return {'ok', encodeRecord(record)}
end
local file = ARGV[4]
local bytes = tonumber(ARGV[5])
local outputField = 'output:' .. file
local outputIndex = nil
if not compact and (op == 'reserve' or op == 'release') then
  for i, id in ipairs(record.output_file_ids) do if id == file then outputIndex = i end end
end
local existing = compact and redis.call('HGET', key, outputField) or outputIndex
if op == 'release' then
  -- A retried release must not refund another operation's request or byte budget.
  if not existing then return {'ok'} end
  local reservedBytes = compact and tonumber(existing) or bytes
  if compact and reservedBytes ~= bytes then return denied('Upload release does not match reservation') end
  add('uploaded_bytes', -math.min(number('uploaded_bytes'), reservedBytes))
  add('upload_count', -1)
  add('request_count', -1)
  if compact then redis.call('HDEL', key, outputField) else table.remove(record.output_file_ids, outputIndex) end
elseif op == 'reserve' or op == 'read' or op == 'tool' then
  if number('request_count') >= number('max_requests') then return denied('Egress grant request budget exceeded') end
  if op == 'reserve' then
    local maxBytes = math.min(number('max_upload_bytes'), tonumber(ARGV[6]))
    if not bytes or bytes < 0 or bytes ~= math.floor(bytes) or bytes > maxBytes then
      return denied('Upload exceeds per-file egress byte limit')
    end
    if existing then return denied('Output file id has already been used for this grant') end
    if number('upload_count') >= number('max_output_files') then return denied('Output file count budget exceeded') end
    if number('uploaded_bytes') + bytes > maxBytes * number('max_output_files') then return denied('Aggregate upload byte budget exceeded') end
    add('uploaded_bytes', bytes)
    add('upload_count', 1)
    if compact then redis.call('HSET', key, outputField, bytes) else table.insert(record.output_file_ids, file) end
  elseif op == 'read' then add('read_count', 1)
  else add('tool_call_count', 1) end
  add('request_count', 1)
else return denied('Unknown egress ledger operation') end
save()
return {'ok'}
`;
