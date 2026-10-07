#!/usr/bin/env python3
"""Render the real chart without downloading Redis/MinIO or contacting a cluster.

Requires Helm and PyYAML. Run: python3 tests/helm_customization.py
"""

import copy
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = {
    "api": "api",
    "fileServer": "file-server",
    "toolCallServer": "tool-call-server",
    "egressGateway": "egress-gateway",
    "workerSandbox.serviceWorker": "service-worker",
    "workerSandbox.sandboxRunner": "sandbox-runner",
}


def set_value(values, path, value):
    parts = path.split(".")
    for part in parts[:-1]:
        values = values.setdefault(part, {})
    values[parts[-1]] = value


def env(container, name):
    return next(item for item in container["env"] if item["name"] == name)


class HelmCustomization(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.chart = Path(cls.tmp.name) / "chart"
        cls.chart.mkdir()
        source = ROOT / "helm/codeapi"
        shutil.copytree(source / "templates", cls.chart / "templates")
        shutil.copy(source / "values.yaml", cls.chart / "values.yaml")
        (cls.chart / "Chart.yaml").write_text(
            (source / "Chart.yaml").read_text().split("dependencies:")[0]
        )

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def render(self, values=None, signing_keys=True, failure=None):
        config = (
            {
                "executionManifest": {
                    "privateKey": "test-private",
                    "publicKey": "test-public",
                }
            }
            if signing_keys
            else {}
        )
        config.update(values or {})
        path = Path(self.tmp.name) / "test-values.yaml"
        path.write_text(yaml.safe_dump(config))
        result = subprocess.run(
            [
                os.environ.get("HELM", "helm"),
                "template",
                "example",
                str(self.chart),
                "--namespace",
                "test",
                "-f",
                str(path),
            ],
            capture_output=True,
            text=True,
        )
        if failure:
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(failure, result.stderr)
            return
        self.assertEqual(result.returncode, 0, result.stderr)

        # A normal YAML loader silently accepts duplicate keys, hiding broken
        # metadata/security/volume merges in rendered Kubernetes resources.
        class UniqueLoader(yaml.SafeLoader):
            pass

        def mapping(loader, node):
            pairs = loader.construct_pairs(node)
            keys = [key for key, _ in pairs]
            self.assertEqual(len(keys), len(set(keys)), f"duplicate keys: {keys}")
            return dict(pairs)

        UniqueLoader.add_constructor(
            yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping
        )
        docs = [doc for doc in yaml.load_all(result.stdout, Loader=UniqueLoader) if doc]
        resources = {(d["kind"], d["metadata"]["name"]): d for d in docs}
        self.assertEqual(len(docs), len(resources), "duplicate Kubernetes resources")
        return resources

    def pod(self, resources, component):
        return resources[("Deployment", "example-codeapi-" + component)]["spec"][
            "template"
        ]["spec"]

    def test_existing_secret_needs_no_inline_keys_and_keeps_credentials_in_their_tiers(
        self,
    ):
        resources = self.render(
            {
                "secrets": {
                    "existingSecret": "external-credentials",
                    "keys": {
                        "internalServiceToken": "internal",
                        "egressGrantSecret": "grant",
                        "executionManifestPrivateKey": "signer",
                        "executionManifestPublicKey": "verifier",
                        "redisPassword": "queue-password",
                        "s3AccessKey": "access",
                        "s3SecretKey": "secret",
                    },
                },
                "minio": {"enabled": False},
                "fileServer": {"s3": {"enabled": True}},
            },
            signing_keys=False,
        )
        self.assertFalse(any(kind == "Secret" for kind, _ in resources))
        expected = {
            "api": {
                "REDIS_PASSWORD": "queue-password",
                "CODEAPI_INTERNAL_SERVICE_TOKEN": "internal",
            },
            "service-worker": {
                "REDIS_PASSWORD": "queue-password",
                "CODEAPI_INTERNAL_SERVICE_TOKEN": "internal",
                "CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY": "signer",
            },
            "file-server": {
                "MINIO_ACCESS_KEY": "access",
                "MINIO_SECRET_KEY": "secret",
                "REDIS_PASSWORD": "queue-password",
                "CODEAPI_INTERNAL_SERVICE_TOKEN": "internal",
            },
            "tool-call-server": {
                "REDIS_PASSWORD": "queue-password",
                "CODEAPI_INTERNAL_SERVICE_TOKEN": "internal",
            },
            "egress-gateway": {
                "REDIS_PASSWORD": "queue-password",
                "CODEAPI_INTERNAL_SERVICE_TOKEN": "internal",
                "CODEAPI_EGRESS_GRANT_SECRET": "grant",
            },
            "sandbox-runner": {"SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY": "verifier"},
        }
        for component, refs in expected.items():
            with self.subTest(component=component):
                container = self.pod(resources, component)["containers"][0]
                actual = {
                    e["name"]: e["valueFrom"]["secretKeyRef"]
                    for e in container["env"]
                    if "secretKeyRef" in e.get("valueFrom", {})
                }
                self.assertEqual(
                    actual,
                    {
                        name: {"name": "external-credentials", "key": key}
                        for name, key in refs.items()
                    },
                )

    def test_managed_secrets_and_missing_key_validation_remain_supported(self):
        resources = self.render()
        secret = resources[("Secret", "example-codeapi-secrets")]
        self.assertEqual(
            secret["stringData"]["codeapi-execution-manifest-private-key"],
            "test-private",
        )
        runner = self.pod(resources, "sandbox-runner")["containers"][0]
        self.assertEqual(
            env(runner, "SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY")["value"], "test-public"
        )
        self.render(signing_keys=False, failure="requires executionManifest.privateKey")
        self.render(
            {"executionManifest": {"privateKey": "test"}},
            signing_keys=False,
            failure="requires executionManifest.publicKey",
        )
        custom = self.render(
            {"secrets": {"keys": {"internalServiceToken": "my-token"}}}
        )
        self.assertIn(
            "my-token", custom[("Secret", "example-codeapi-secrets")]["stringData"]
        )
        self.assertEqual(
            env(
                self.pod(custom, "api")["containers"][0],
                "CODEAPI_INTERNAL_SERVICE_TOKEN",
            )["valueFrom"]["secretKeyRef"]["key"],
            "my-token",
        )

    def test_each_deployment_can_be_customized_without_changing_selectors(self):
        values = {
            "commonLabels": {
                "environment": "test",
                "app.kubernetes.io/component": "wrong",
            }
        }
        for i, path in enumerate(COMPONENTS):
            options = {
                "deploymentAnnotations": {"example.org/wave": str(i)},
                "podLabels": {"team": str(i), "app.kubernetes.io/component": "wrong"},
                "podAnnotations": {"example.org/pod": str(i)},
                "podSecurityContext": {
                    "runAsUser": 1000 + i,
                    "seccompProfile": {"type": "RuntimeDefault"},
                },
                "securityContext": {
                    "allowPrivilegeEscalation": False,
                    "readOnlyRootFilesystem": True,
                    "capabilities": {"drop": ["ALL"]},
                },
                "extraVolumes": [{"name": "scratch", "emptyDir": {}}],
                "extraVolumeMounts": [{"name": "scratch", "mountPath": "/tmp"}],
                "strategy": {
                    "type": "RollingUpdate",
                    "rollingUpdate": {"maxSurge": 0, "maxUnavailable": 1},
                },
                "resources": {
                    "requests": {"cpu": "123m", "memory": "77Mi"},
                    "limits": {"memory": "99Mi"},
                },
            }
            for key, value in options.items():
                set_value(values, path + "." + key, value)
        base = self.render()
        resources = self.render(values)
        for i, component in enumerate(COMPONENTS.values()):
            with self.subTest(component=component):
                key = ("Deployment", "example-codeapi-" + component)
                d = resources[key]
                self.assertEqual(d["spec"]["selector"], base[key]["spec"]["selector"])
                self.assertEqual(
                    d["metadata"].get("annotations", {}).get("example.org/wave"), str(i)
                )
                self.assertEqual(d["metadata"]["labels"]["environment"], "test")
                self.assertEqual(
                    d["metadata"]["labels"]["app.kubernetes.io/component"], component
                )
                self.assertEqual(
                    d["spec"]["template"]["metadata"]["labels"][
                        "app.kubernetes.io/component"
                    ],
                    component,
                )
                self.assertEqual(
                    d["spec"]["template"]["metadata"]["annotations"]["example.org/pod"],
                    str(i),
                )
                pod = self.pod(resources, component)
                self.assertEqual(pod["securityContext"]["runAsUser"], 1000 + i)
                self.assertIn({"name": "scratch", "emptyDir": {}}, pod["volumes"])
                c = pod["containers"][0]
                self.assertFalse(c["securityContext"]["allowPrivilegeEscalation"])
                self.assertIn(
                    {"name": "scratch", "mountPath": "/tmp"}, c["volumeMounts"]
                )
                self.assertEqual(c["resources"]["requests"]["cpu"], "123m")
                self.assertEqual(d["spec"]["strategy"]["rollingUpdate"]["maxSurge"], 0)
        self.assertEqual(
            resources[("Deployment", "example-codeapi-api")]["spec"]["template"][
                "metadata"
            ]["annotations"]["codeapi.librechat.ai/pairing-fence-version"],
            "1",
        )

    def test_service_accounts_support_existing_names_false_and_true_token_mounting(
        self,
    ):
        paths = {
            "api": "api.serviceAccount",
            "file-server": "fileServer.serviceAccount",
            "tool-call-server": "toolCallServer.serviceAccount",
            "egress-gateway": "egressGateway.serviceAccount",
            "service-worker": "workerSandbox.serviceAccount",
            "sandbox-runner": "workerSandbox.sandboxServiceAccount",
        }
        values = {}
        for component, path in paths.items():
            set_value(
                values,
                path,
                {
                    "create": True,
                    "name": "sa-" + component,
                    "automountServiceAccountToken": False,
                    "annotations": {"example.org/identity": component},
                },
            )
        resources = self.render(values)
        for component in paths:
            pod = self.pod(resources, component)
            self.assertEqual(pod.get("serviceAccountName"), "sa-" + component)
            self.assertIs(pod["automountServiceAccountToken"], False)
            sa = resources[("ServiceAccount", "sa-" + component)]
            self.assertIs(sa["automountServiceAccountToken"], False)
            self.assertEqual(
                sa["metadata"]["annotations"]["example.org/identity"], component
            )
        for path in paths.values():
            set_value(values, path + ".create", False)
            set_value(values, path + ".automountServiceAccountToken", True)
        resources = self.render(values)
        self.assertFalse(any(kind == "ServiceAccount" for kind, _ in resources))
        for component in paths:
            self.assertIs(
                self.pod(resources, component)["automountServiceAccountToken"], True
            )
        for path in paths.values():
            set_value(values, path + ".create", True)
            set_value(values, path + ".automountServiceAccountToken", None)
        resources = self.render(values)
        for component in paths:
            self.assertNotIn(
                "automountServiceAccountToken", self.pod(resources, component)
            )
            self.assertNotIn(
                "automountServiceAccountToken",
                resources[("ServiceAccount", "sa-" + component)],
            )

    def test_init_container_hardening_and_hpa_behavior(self):
        values = {}
        for path in ["workerSandbox.serviceWorker", "egressGateway"]:
            set_value(
                values,
                path + ".initContainerSecurityContext",
                {"runAsUser": 65534, "allowPrivilegeEscalation": False},
            )
            set_value(
                values,
                path + ".initImage",
                {"repository": "registry.example/busybox", "tag": "pinned"},
            )
        for path in ["api.autoscaling", "workerSandbox.sandboxRunner.autoscaling"]:
            set_value(values, path + ".enabled", True)
            set_value(
                values,
                path + ".behavior",
                {"scaleDown": {"stabilizationWindowSeconds": 300}},
            )
        resources = self.render(values)
        for component in ["service-worker", "egress-gateway"]:
            for init in self.pod(resources, component)["initContainers"]:
                self.assertEqual(init["image"], "registry.example/busybox:pinned")
                self.assertEqual(init["securityContext"]["runAsUser"], 65534)
                self.assertIs(
                    init["securityContext"]["allowPrivilegeEscalation"], False
                )
        for component in ["api", "sandbox-runner"]:
            hpa = resources[("HorizontalPodAutoscaler", "example-codeapi-" + component)]
            self.assertEqual(
                hpa["spec"]["behavior"]["scaleDown"]["stabilizationWindowSeconds"], 300
            )

    def test_runner_overrides_preserve_mode_defaults_and_device_resources(self):
        values = {
            "workerSandbox": {
                "sandboxRunner": {
                    "podSecurityContext": {"runAsUser": 0},
                    "securityContext": {"allowPrivilegeEscalation": False},
                }
            }
        }
        hostpath = self.pod(self.render(values), "sandbox-runner")
        self.assertEqual(hostpath["securityContext"]["supplementalGroups"], [108])
        self.assertEqual(
            hostpath["containers"][0]["securityContext"]["seccompProfile"],
            {"type": "RuntimeDefault"},
        )
        self.assertFalse(hostpath["containers"][0]["securityContext"]["privileged"])
        self.assertIs(
            hostpath["containers"][0]["securityContext"].get(
                "allowPrivilegeEscalation"
            ),
            False,
        )
        self.assertIn(
            {"name": "dev-kvm", "mountPath": "/dev/kvm"},
            hostpath["containers"][0]["volumeMounts"],
        )
        values["workerSandbox"]["kvmDevicePlugin"] = {
            "enabled": True,
            "resourceName": "example.org/kvm",
        }
        device = self.pod(self.render(values), "sandbox-runner")
        self.assertEqual(
            device["containers"][0]["resources"]["requests"]["example.org/kvm"], "1"
        )
        self.assertEqual(
            device["containers"][0]["resources"]["limits"]["example.org/kvm"], "1"
        )
        self.assertNotIn("volumes", device)
        direct = copy.deepcopy(values)
        direct["workerSandbox"].update(
            {"kvmEnabled": False, "packages": {"source": "pvc"}}
        )
        context = self.pod(self.render(direct), "sandbox-runner")["containers"][0][
            "securityContext"
        ]
        self.assertEqual(context["seccompProfile"], {"type": "Unconfined"})
        self.assertIn("SYS_ADMIN", context["capabilities"]["add"])

    def test_runner_can_replace_a_localhost_seccomp_profile(self):
        resources = self.render(
            {
                "workerSandbox": {
                    "seccomp": {"enabled": True},
                    "sandboxRunner": {
                        "securityContext": {
                            "seccompProfile": {"type": "RuntimeDefault"},
                        }
                    },
                }
            }
        )
        context = self.pod(resources, "sandbox-runner")["containers"][0][
            "securityContext"
        ]
        self.assertEqual(context["seccompProfile"], {"type": "RuntimeDefault"})
        self.assertIs(context["privileged"], False)

    def test_shared_affinity_and_tolerations_reach_all_service_deployments(self):
        values = {
            "affinity": {
                "podAntiAffinity": {
                    "preferredDuringSchedulingIgnoredDuringExecution": [
                        {
                            "weight": 100,
                            "podAffinityTerm": {
                                "topologyKey": "kubernetes.io/hostname",
                                "labelSelector": {
                                    "matchLabels": {"app.kubernetes.io/name": "codeapi"}
                                },
                            },
                        }
                    ]
                }
            },
            "tolerations": [{"key": "example.org/spot", "operator": "Exists"}],
        }
        resources = self.render(values)
        for component in ["api", "file-server", "tool-call-server", "egress-gateway"]:
            with self.subTest(component=component):
                pod = self.pod(resources, component)
                self.assertEqual(pod.get("affinity"), values["affinity"])
                self.assertEqual(pod.get("tolerations"), values["tolerations"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
