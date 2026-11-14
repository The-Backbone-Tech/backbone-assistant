// Chart lifecycle only; no platform writes. Kubernetes serializes pod ownership and waits.
import https from 'node:https';
import { readFileSync } from 'node:fs';
const namespace = process.env.NAMESPACE, release = process.env.RELEASE;
const timeout = Number(process.env.TIMEOUT) * 1000;
const base = `/apis/apps/v1/namespaces/${namespace}/statefulsets`;
const pods = `/api/v1/namespaces/${namespace}/pods`;
const jobs = `/apis/batch/v1/namespaces/${namespace}/jobs`;
const credentials = '/var/run/secrets/kubernetes.io/serviceaccount';
const ca = readFileSync(`${credentials}/ca.crt`);
async function request(method, path, body) {
  const token = readFileSync(`${credentials}/token`, 'utf8');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(`https://kubernetes.default.svc${path}`, {
      method, ca, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json', ...(payload === undefined ? {} : {'Content-Length': Buffer.byteLength(payload)}) }, timeout: 30000,
    }, res => {
      let bytes = ''; res.on('data', b => bytes += b);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${method} ${path}: HTTP ${res.statusCode}`));
        try { resolve(bytes ? JSON.parse(bytes) : {}); }
        catch { reject(new Error(`${method} ${path}: invalid Kubernetes JSON response`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Kubernetes request timed out')));
    req.on('error', reject); req.end(payload);
  });
}
async function until(check, label) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 1000));
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}; later homes were not touched.`);
}
const ready = pod => pod?.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True');
const scale = (name, replicas) => request('PATCH', `${base}/${name}/scale`, { spec: { replicas } });
const names=JSON.parse(process.env.HOMES);
for (const known of names.sort()) {
  const set=await request('GET',`${base}/${known}`);
  if(!set){if(process.argv[2]==='backup')continue;throw new Error('A configured home is missing.');}
  const name = set.metadata.name, podName = `${name}-0`;
  if (process.argv[2] === 'backup') {
    const pod = await request('GET', `${pods}/${podName}`);
    if (!ready(pod)) throw new Error(`${name} is not Ready; no upgrade attempted.`);
    console.log(`Backing up ${name} with ${pod.spec.containers[0].image}`);
    await scale(name, 0);
    const jobName = `${name}-backup`;
    try {
      await until(async () => !await request('GET', `${pods}/${podName}`), `${name} stopped`);
      // Unique per Helm revision. A failed or interrupted backup is never silently repeated.
      if (await request('GET', `${jobs}/${jobName}`)) throw new Error(`${jobName} already exists; inspect it before retrying.`);
      const container = structuredClone(pod.spec.containers[0]);
      delete container.readinessProbe; delete container.startupProbe; delete container.livenessProbe;
      const to = `/backups/archives/revision-${process.env.REVISION}`;
      container.command = ['node', '/fleet/backup.mjs', to];
      delete container.args;
      container.env.push({name:'BACKBONE_BACKUP_ROOT',value:'/backups/archives'},{name:'BACKBONE_BACKUP_RETENTION',value:process.env.RETENTION});
      container.volumeMounts.push({name:'backups',mountPath:'/backups'});
      const volumes=structuredClone(pod.spec.volumes);
      volumes.find(v=>v.name==='runtime').configMap.name=process.env.RUNTIME_CONFIGMAP;
      volumes.push({name:'backups',persistentVolumeClaim:{claimName:`${name}-backups`}});
      const init=structuredClone(pod.spec.initContainers);
      const prepare=init.find(c=>c.name==='prepare');
      prepare.env=[...(prepare.env??[]),{name:'BACKBONE_BACKUP_ROOT',value:'/backups/archives'}];
      prepare.volumeMounts.push({name:'backups',mountPath:'/backups'});
      const spec = { restartPolicy: 'Never', automountServiceAccountToken: false,
        securityContext: pod.spec.securityContext, containers: [container], volumes,
        initContainers: init,
        ...(pod.spec.nodeSelector ? {nodeSelector: pod.spec.nodeSelector} : {}),
        ...(pod.spec.tolerations ? {tolerations: pod.spec.tolerations} : {}),
      };
      await request('POST', jobs, { apiVersion: 'batch/v1', kind: 'Job', metadata: {name: jobName}, spec: {parallelism:1,completions:1,backoffLimit: 0, activeDeadlineSeconds: Math.floor(timeout / 1000), template: {metadata:{labels:{'app.kubernetes.io/instance':release,'app.kubernetes.io/component':'backup'}},spec}} });
      await until(async () => {
        const job = await request('GET', `${jobs}/${jobName}`);
        if (job?.status?.failed) throw new Error(`${jobName} failed; inspect its logs. Upgrade stopped.`);
        return job?.status?.succeeded === 1;
      }, `${name} backup`);
      // Retain failed jobs for inspection. Completed pods must release the volume before restart.
      await request('DELETE', `${jobs}/${jobName}`, {propagationPolicy: 'Foreground'});
      await until(async () => !await request('GET', `${jobs}/${jobName}`), `${name} backup detached`);
    } finally {
      const job = await request('GET', `${jobs}/${jobName}`);
      if (job && !job.status?.succeeded && !job.status?.failed) {
        throw new Error(`${jobName} may still hold the volume; ${name} remains stopped. Inspect the job before restarting.`);
      }
      await scale(name, 1);
    }
    await until(async () => ready(await request('GET', `${pods}/${podName}`)), `${name} ready after backup`);
  } else {
    // Helm may invoke a hook before the StatefulSet controller observes the new generation.
    let desired;
    await until(async () => {
      desired = await request('GET', `${base}/${name}`);
      return desired?.status?.observedGeneration >= desired?.metadata?.generation && desired.status.updateRevision;
    }, `${name} controller observed desired template`);
    const pod = await request('GET', `${pods}/${podName}`);
    const revision = desired.status.updateRevision;
    if (!revision) throw new Error(`${name} has no controller revision yet; retry only after inspection.`);
    if (pod && pod.metadata.labels['controller-revision-hash'] !== revision) {
      console.log(`Replacing ${name} with ${set.spec.template.spec.containers[0].image}`);
      const uid = pod.metadata.uid;
      await request('DELETE', `${pods}/${podName}`, {preconditions: {uid}});
      await until(async () => (await request('GET', `${pods}/${podName}`))?.metadata.uid !== uid, `${name} replaced`);
    }
    await until(async () => {
      const current = await request('GET', `${pods}/${podName}`);
      return ready(current) && current.metadata.labels['controller-revision-hash'] === revision;
    }, `${name} Ready on requested revision`);
    console.log(`${name} Ready`);
  }
}
