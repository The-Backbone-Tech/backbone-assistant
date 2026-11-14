{{- define "fleet.validate" -}}
{{- if gt (len .Release.Name) 30 }}{{ fail "release name must be at most 30 characters" }}{{ end -}}
{{- if ne .Release.Namespace .Values.namespace.name }}{{ fail "install in the dedicated namespace named by namespace.name" }}{{ end -}}
{{- $names := dict -}}
{{- range .Values.homes -}}
{{- if hasKey $names .name }}{{ fail (printf "duplicate home: %s" .name) }}{{ end -}}
{{- $_ := set $names .name true -}}
{{- end -}}
{{- end -}}
{{- define "fleet.runtime" -}}
{{- printf "%s-runtime-%s" .Release.Name (trunc 8 ((.Files.Glob "files/*").AsConfig | sha256sum)) -}}
{{- end -}}
{{- define "fleet.homeNames" -}}{{- $out := list -}}{{- range .Values.homes -}}{{- $out = append $out (printf "%s-%s" $.Release.Name .name) -}}{{- end -}}{{ toJson $out }}{{- end -}}
{{- define "fleet.podNames" -}}{{- $out := list -}}{{- range .Values.homes -}}{{- $out = append $out (printf "%s-%s-0" $.Release.Name .name) -}}{{- end -}}{{ toJson $out }}{{- end -}}
{{- define "fleet.backupNames" -}}{{- $out := list -}}{{- range .Values.homes -}}{{- $out = append $out (printf "%s-%s-backup" $.Release.Name .name) -}}{{- end -}}{{ toJson $out }}{{- end -}}
{{- define "fleet.backupHomes" -}}
{{- $out := list -}}{{- if .Release.IsUpgrade -}}{{- range (lookup "apps/v1" "StatefulSet" .Release.Namespace "").items -}}{{- if and (eq (index .metadata.labels "app.kubernetes.io/instance") $.Release.Name) (eq (index .metadata.labels "app.kubernetes.io/component") "home") -}}{{- $out = append $out .metadata.name -}}{{- end -}}{{- end -}}{{- end -}}
{{- if not $out -}}{{ include "fleet.homeNames" . }}{{- else -}}{{ toJson (sortAlpha $out) }}{{- end -}}
{{- end -}}
{{- define "fleet.admissionName" -}}{{ printf "%s-%s-backups" .Release.Name (trunc 12 (.Release.Namespace | sha256sum)) }}{{- end -}}
{{- define "fleet.dnsRule" -}}{"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}], "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]}{{- end -}}
{{- define "fleet.modelRules" -}}{{- $out := list -}}{{- range .Values.network.modelEgress -}}{{- $out = append $out (dict "to" (list (dict "ipBlock" (dict "cidr" .cidr))) "ports" (list (dict "protocol" "TCP" "port" .port))) -}}{{- end -}}{{ toJson $out }}{{- end -}}
{{- define "fleet.apiPeers" -}}{{- $out := list -}}{{- range .Values.network.apiServerCidrs -}}{{- $out = append $out (dict "ipBlock" (dict "cidr" .)) -}}{{- end -}}{{ toJson $out }}{{- end -}}
{{- define "fleet.backupTemplate" -}}{{- $parts := list -}}{{- range .Values.homes -}}
{{- $name := printf "%s-%s" $.Release.Name .name -}}
{{- $part := printf "(object.metadata.name == %s && object.spec.template.metadata.labels['app.kubernetes.io/instance'] == %s && object.spec.template.metadata.labels['app.kubernetes.io/component'] == 'backup' && object.spec.template.spec.volumes.exists(v, v.name == 'data' && v.persistentVolumeClaim.claimName == %s) && object.spec.template.spec.volumes.exists(v, v.name == 'backups' && v.persistentVolumeClaim.claimName == %s) && object.spec.template.spec.volumes.exists(v, v.name == 'policy-source' && v.configMap.name == %s) && object.spec.template.spec.volumes.exists(v, v.name == 'runtime' && v.configMap.name.startsWith(%s)) && object.spec.template.spec.volumes.filter(v, v.name in ['policy','pg-runtime','scratch']).all(v, has(v.emptyDir)))" (printf "%s-backup" $name | toJson) ($.Release.Name | toJson) (printf "data-%s-0" $name | toJson) (printf "%s-backups" $name | toJson) ($name | toJson) (printf "%s-runtime-" $.Release.Name | toJson) -}}
{{- $parts = append $parts $part -}}{{- end -}}{{ join " || " $parts }}{{- end -}}
