{{/*
_helpers.tpl - Reusable template snippets

Helm templates use Go templating. Key concepts:
- {{ .Values.xxx }} - Access values from values.yaml
- {{ .Release.Name }} - The name you gave when installing (helm install MY-NAME ...)
- {{ .Chart.Name }} - The chart name from Chart.yaml
- {{- ... }} - The dash suppresses whitespace
- define/include - Create and use reusable snippets
*/}}

{{/*
Expand the name of the chart.
*/}}
{{- define "codeapi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this.
*/}}
{{- define "codeapi.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "codeapi.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels - applied to all resources
*/}}
{{- define "codeapi.labels" -}}
helm.sh/chart: {{ include "codeapi.chart" . }}
{{ include "codeapi.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels - used for pod selection
*/}}
{{- define "codeapi.selectorLabels" -}}
app.kubernetes.io/name: {{ include "codeapi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
API specific labels
*/}}
{{- define "codeapi.api.labels" -}}
{{ include "codeapi.labels" . }}
app.kubernetes.io/component: api
{{- end }}

{{- define "codeapi.api.selectorLabels" -}}
{{ include "codeapi.selectorLabels" . }}
app.kubernetes.io/component: api
{{- end }}

{{/*
Worker-Sandbox specific labels
*/}}
{{- define "codeapi.workerSandbox.labels" -}}
{{ include "codeapi.labels" . }}
app.kubernetes.io/component: worker-sandbox
{{- end }}

{{- define "codeapi.workerSandbox.selectorLabels" -}}
{{ include "codeapi.selectorLabels" . }}
app.kubernetes.io/component: worker-sandbox
{{- end }}

{{/*
Service Worker specific labels
*/}}
{{- define "codeapi.serviceWorker.labels" -}}
{{ include "codeapi.labels" . }}
app.kubernetes.io/component: service-worker
{{- end }}

{{- define "codeapi.serviceWorker.selectorLabels" -}}
{{ include "codeapi.selectorLabels" . }}
app.kubernetes.io/component: service-worker
{{- end }}

{{/*
Sandbox Runner specific labels
*/}}
{{- define "codeapi.sandboxRunner.labels" -}}
{{ include "codeapi.labels" . }}
app.kubernetes.io/component: sandbox-runner
{{- end }}

{{- define "codeapi.sandboxRunner.selectorLabels" -}}
{{ include "codeapi.selectorLabels" . }}
app.kubernetes.io/component: sandbox-runner
{{- end }}

{{/*
Egress Gateway specific labels
*/}}
{{- define "codeapi.egressGateway.labels" -}}
{{ include "codeapi.labels" . }}
app.kubernetes.io/component: egress-gateway
{{- end }}

{{- define "codeapi.egressGateway.selectorLabels" -}}
{{ include "codeapi.selectorLabels" . }}
app.kubernetes.io/component: egress-gateway
{{- end }}

{{/*
File Server specific labels
*/}}
{{- define "codeapi.fileServer.labels" -}}
{{ include "codeapi.labels" . }}
app.kubernetes.io/component: file-server
{{- end }}

{{- define "codeapi.fileServer.selectorLabels" -}}
{{ include "codeapi.selectorLabels" . }}
app.kubernetes.io/component: file-server
{{- end }}

{{/*
Tool Call Server specific labels
*/}}
{{- define "codeapi.toolCallServer.labels" -}}
{{ include "codeapi.labels" . }}
app.kubernetes.io/component: tool-call-server
{{- end }}

{{- define "codeapi.toolCallServer.selectorLabels" -}}
{{ include "codeapi.selectorLabels" . }}
app.kubernetes.io/component: tool-call-server
{{- end }}

{{/*
Redis host - either from subchart or external.
In cluster mode this renders the comma-separated node list from redis.cluster.nodes
(falling back to redis.external.host for single-node external deployments).
*/}}
{{- define "codeapi.redis.host" -}}
{{- if .Values.redis.enabled }}
{{- printf "%s-redis-master" .Release.Name }}
{{- else if and .Values.redis.cluster.enabled .Values.redis.cluster.nodes }}
{{- .Values.redis.cluster.nodes }}
{{- else }}
{{- .Values.redis.external.host }}
{{- end }}
{{- end }}

{{/*
Redis port
*/}}
{{- define "codeapi.redis.port" -}}
{{- if .Values.redis.enabled }}
{{- "6379" }}
{{- else }}
{{- .Values.redis.external.port | default "6379" }}
{{- end }}
{{- end }}

{{/*
Redis host used ONLY for the wait-for-redis readiness probe. In cluster mode
codeapi.redis.host renders the full comma-separated startup-node list
("n1:6379,n2:6379,..."), which `nc -z` cannot resolve as a single
[destination] [port] pair. This always resolves to one reachable host —
the first cluster startup node when in cluster mode, otherwise the same
value as codeapi.redis.host.
*/}}
{{- define "codeapi.redis.probeHost" -}}
{{- if .Values.redis.enabled }}
{{- printf "%s-redis-master" .Release.Name }}
{{- else if and .Values.redis.cluster.enabled .Values.redis.cluster.nodes }}
{{- $firstNode := .Values.redis.cluster.nodes | splitList "," | first }}
{{- $firstNode | splitList ":" | first }}
{{- else }}
{{- .Values.redis.external.host }}
{{- end }}
{{- end }}

{{/*
Port companion to codeapi.redis.probeHost.
*/}}
{{- define "codeapi.redis.probePort" -}}
{{- if .Values.redis.enabled }}
{{- "6379" }}
{{- else if and .Values.redis.cluster.enabled .Values.redis.cluster.nodes }}
{{- $firstNode := .Values.redis.cluster.nodes | splitList "," | first }}
{{- $parts := $firstNode | splitList ":" }}
{{- if gt (len $parts) 1 }}
{{- index $parts 1 }}
{{- else }}
{{- "6379" }}
{{- end }}
{{- else }}
{{- .Values.redis.external.port | default "6379" }}
{{- end }}
{{- end }}

{{/*
USE_REDIS_CLUSTER value – "true" when redis.cluster.enabled or when
redis.cluster.nodes contains a comma (auto-detect multiple nodes).
*/}}
{{- define "codeapi.redis.clusterEnabled" -}}
{{- if .Values.redis.cluster.enabled }}
{{- "true" }}
{{- else if and .Values.redis.cluster.nodes (contains "," .Values.redis.cluster.nodes) }}
{{- "true" }}
{{- else }}
{{- "false" }}
{{- end }}
{{- end }}

{{/*
Emit the Redis TLS + CA environment variables and volume mount for each
component that needs it. These only apply to an external managed Redis, so
they render nothing while the bundled subchart is enabled (redis.enabled=true
always uses plain TCP to the in-cluster Bitnami Redis) or when redis.tls.enabled
is false.
Usage: {{ include "codeapi.redis.tlsEnv" . }}
*/}}
{{- define "codeapi.redis.tlsEnv" -}}
{{- if not .Values.redis.enabled }}
{{- if .Values.redis.tls.enabled }}
- name: REDIS_TLS
  value: "true"
{{- if .Values.redis.tls.caSecretName }}
- name: REDIS_CA
  value: {{ .Values.redis.tls.caMountPath | quote }}
{{- end }}
{{- end }}
{{- if .Values.redis.useAlternativeDnsLookup }}
- name: REDIS_USE_ALTERNATIVE_DNS_LOOKUP
  value: "true"
{{- end }}
{{- end }}
{{- end }}

{{/*
Volume definition for the Redis CA certificate secret.
Renders nothing when redis.tls.caSecretName is empty, or the bundled Redis
subchart is enabled (it never speaks TLS).
Usage: {{ include "codeapi.redis.caVolume" . }}
*/}}
{{- define "codeapi.redis.caVolume" -}}
{{- if and (not .Values.redis.enabled) .Values.redis.tls.enabled .Values.redis.tls.caSecretName }}
- name: redis-ca
  secret:
    secretName: {{ .Values.redis.tls.caSecretName }}
    items:
      - key: {{ .Values.redis.tls.caKey }}
        path: ca.crt
{{- end }}
{{- end }}

{{/*
VolumeMount for the Redis CA certificate inside a container.
Renders nothing when redis.tls.caSecretName is empty, or the bundled Redis
subchart is enabled (it never speaks TLS).
Usage: {{ include "codeapi.redis.caVolumeMount" . }}
*/}}
{{- define "codeapi.redis.caVolumeMount" -}}
{{- if and (not .Values.redis.enabled) .Values.redis.tls.enabled .Values.redis.tls.caSecretName }}
- name: redis-ca
  mountPath: {{ .Values.redis.tls.caMountPath | quote }}
  subPath: ca.crt
  readOnly: true
{{- end }}
{{- end }}

{{/*
Redis NetworkPolicy egress. Kubernetes NetworkPolicy cannot match DNS names,
so external Redis can be scoped with CIDRs when available; otherwise the chart
allows the configured Redis port to any destination for the control-plane pods
that explicitly need Redis.
*/}}
{{- define "codeapi.redisEgress" -}}
{{- if .Values.redis.enabled }}
- to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: redis
  ports:
    - protocol: TCP
      port: {{ include "codeapi.redis.port" . }}
{{- else if .Values.networkPolicy.redis.externalCIDRs }}
{{- range .Values.networkPolicy.redis.externalCIDRs }}
- to:
    - ipBlock:
        cidr: {{ . | quote }}
  ports:
    - protocol: TCP
      port: {{ include "codeapi.redis.port" $ }}
{{- end }}
{{- else }}
- ports:
    - protocol: TCP
      port: {{ include "codeapi.redis.port" . }}
{{- end }}
{{- end }}

{{/*
MinIO endpoint - either from subchart, simple deployment, or external
*/}}
{{- define "codeapi.minio.endpoint" -}}
{{- if or .Values.minio.enabled .Values.minio.useSimple }}
{{- printf "%s-minio" (include "codeapi.fullname" .) }}
{{- else }}
{{- .Values.minio.external.endpoint }}
{{- end }}
{{- end }}

{{/*
MinIO port
*/}}
{{- define "codeapi.minio.port" -}}
{{- if or .Values.minio.enabled .Values.minio.useSimple }}
{{- "9000" }}
{{- else }}
{{- .Values.minio.external.port | default "9000" }}
{{- end }}
{{- end }}

{{/*
MinIO bucket name
*/}}
{{- define "codeapi.minio.bucket" -}}
{{- if or .Values.minio.enabled .Values.minio.useSimple }}
{{- .Values.minio.defaultBuckets | default "codeapi-files" }}
{{- else }}
{{- .Values.minio.external.bucket }}
{{- end }}
{{- end }}

{{/*
OpenTelemetry environment shared by CodeAPI components.
*/}}
{{- define "codeapi.otel.env" -}}
{{- $root := .root -}}
- name: OTEL_TRACING_ENABLED
  value: {{ ternary "true" "false" $root.Values.otel.enabled | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ .serviceName | quote }}
{{- if $root.Values.otel.enabled }}
{{- if $root.Values.otel.exporterOtlpEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ $root.Values.otel.exporterOtlpEndpoint | quote }}
{{- end }}
{{- if $root.Values.otel.exporterOtlpTracesEndpoint }}
- name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  value: {{ $root.Values.otel.exporterOtlpTracesEndpoint | quote }}
{{- end }}
{{- if $root.Values.otel.exporterOtlpHeaders }}
- name: OTEL_EXPORTER_OTLP_HEADERS
  value: {{ $root.Values.otel.exporterOtlpHeaders | quote }}
{{- end }}
{{- if $root.Values.otel.resourceAttributes }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: {{ $root.Values.otel.resourceAttributes | quote }}
{{- end }}
{{- end }}
{{- end }}

{{/*
OpenTelemetry collector egress. Set networkPolicy.otel selectors to match
your collector's namespace and pod labels.
*/}}
{{- define "codeapi.otelEgress" -}}
{{- if and .Values.otel.enabled .Values.networkPolicy.otel.enabled }}
- to:
    - namespaceSelector:
        {{- toYaml .Values.networkPolicy.otel.namespaceSelector | nindent 8 }}
      podSelector:
        {{- toYaml .Values.networkPolicy.otel.podSelector | nindent 8 }}
  ports:
    - protocol: TCP
      port: {{ .Values.networkPolicy.otel.port }}
{{- end }}
{{- end }}
