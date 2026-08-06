import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { parseResultsCsv, type ResultsCsvKey, type ResultsCsvData } from '../lib/resultsCsv';

/**
 * Interactive per-epoch line charts from a training job's RESULTS_CSV artifact
 * (`results.csv`). Replaces the static training `results.png` chart with the raw
 * curves, so the numbers are readable and hoverable.
 *
 * Hand-drawn SVG — no charting library. All metrics in the CSV are per-epoch
 * already, so a chart is a polyline per series with a hover crosshair that reads
 * every series at that epoch.
 *
 * Two entry points: `TrainingCurves` (one job's curves) and `MultiModelCurves`
 * (the same curves overlaid for the models being compared in Compare Models).
 */

interface LineSeries {
  id: string;
  label: string;
  color: string;
  dash: string | null;
  values: (number | null)[];
}

const METRIC_DASH: Partial<Record<ResultsCsvKey, string>> = {
  valBoxLoss: '5 4',
  valClsLoss: '5 4',
  map5095: '4 3',
  precision: '2 3',
  recall: '1 3',
};

const METRIC_COLOR: Record<ResultsCsvKey, string> = {
  trainBoxLoss: '#2f7ff5',
  valBoxLoss: '#2f7ff5',
  trainClsLoss: '#e8709a',
  valClsLoss: '#e8709a',
  map50: '#e45d25',
  map5095: '#20c25a',
  precision: '#9b8cfa',
  recall: '#2bb8ac',
};

const METRIC_LABEL: Record<ResultsCsvKey, string> = {
  trainBoxLoss: 'Train box loss',
  valBoxLoss: 'Val box loss',
  trainClsLoss: 'Train cls loss',
  valClsLoss: 'Val cls loss',
  map50: 'mAP50',
  map5095: 'mAP50-95',
  precision: 'Precision',
  recall: 'Recall',
};

function groupHasData(data: ResultsCsvData, keys: ResultsCsvKey[]): boolean {
  return keys.some((k) => (data.series[k]?.length ?? 0) > 0);
}

/** Fetches a RESULTS_CSV artifact body and parses it into per-epoch series. */
export function useResultsCsv(artifactId: string | null) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['artifact-csv', artifactId],
    queryFn: () => fetch(`/api/v1/artifacts/${artifactId}/view`).then((r) => r.text()),
    enabled: !!artifactId,
  });
  const parsed = useMemo(() => (data ? parseResultsCsv(data) : null), [data]);
  return { data: parsed, isLoading, error };
}

interface LineGraphProps {
  epochs: number[];
  series: LineSeries[];
  height?: number;
}

const LINE_W = 560;
const LINE_PAD_L = 40;
const LINE_PAD_R = 12;
const LINE_PAD_T = 10;
const LINE_PAD_B = 24;

/** Multi-line SVG plot with a shared value axis and a hover crosshair reading all series. */
function LineGraph({ epochs, series, height = 220 }: LineGraphProps) {
  const [hover, setHover] = useState<number | null>(null);
  const innerW = LINE_W - LINE_PAD_L - LINE_PAD_R;
  const innerH = height - LINE_PAD_T - LINE_PAD_B;
  const maxEpoch = Math.max(1, epochs.length - 1);
  const max = useMemo(() => {
    let m = 1;
    for (const s of series) for (const v of s.values) if (v != null && v > m) m = v;
    return Math.ceil(m * 10) / 10;
  }, [series]);
  const xFor = (i: number) => LINE_PAD_L + (i / maxEpoch) * innerW;
  const yFor = (v: number) => LINE_PAD_T + innerH - (v / max) * innerH;

  const pathFor = (s: LineSeries) => {
    let d = '';
    let pen = false;
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${xFor(i)},${yFor(v)}`;
      pen = true;
    }
    return d;
  };

  const hoverEpoch = hover != null ? epochs[hover] ?? hover + 1 : null;
  const hoverX = hover != null ? xFor(hover) : 0;

  return (
    <div className="curve-graph">
      <svg
        width="100%"
        viewBox={`0 0 ${LINE_W} ${height}`}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rx = ((e.clientX - rect.left) / rect.width) * LINE_W;
          const i = Math.round(((rx - LINE_PAD_L) / innerW) * maxEpoch);
          setHover(Math.max(0, Math.min(maxEpoch, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={LINE_PAD_L} y1={LINE_PAD_T} x2={LINE_PAD_L} y2={LINE_PAD_T + innerH} stroke="var(--border)" />
        <line x1={LINE_PAD_L} y1={LINE_PAD_T + innerH} x2={LINE_W - LINE_PAD_R} y2={LINE_PAD_T + innerH} stroke="var(--border)" />
        {[0.25, 0.5, 0.75, 1].map((f) => {
          const y = LINE_PAD_T + innerH - f * innerH;
          return (
            <g key={f}>
              <line x1={LINE_PAD_L} y1={y} x2={LINE_W - LINE_PAD_R} y2={y} stroke="var(--border)" strokeDasharray="3 3" strokeOpacity="0.5" />
              <text x={LINE_PAD_L - 6} y={y + 3} textAnchor="end" fontSize="9" fill="var(--text-sub)">{max * f}</text>
            </g>
          );
        })}
        {series.map((s) => (
          <path key={s.id} d={pathFor(s)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash ?? undefined} />
        ))}
        {hover != null && hoverEpoch != null && (
          <g>
            <line x1={hoverX} y1={LINE_PAD_T} x2={hoverX} y2={LINE_PAD_T + innerH} stroke="var(--text-sub)" strokeDasharray="2 3" />
            <text x={hoverX} y={LINE_PAD_T + 4} textAnchor="middle" fontSize="9" fill="var(--text-sub)">epoch {hoverEpoch}</text>
            {series.length <= 8 && (
              <>
                <rect x={hoverX + 6} y={LINE_PAD_T + 14} width={112} height={10 + series.length * 12} fill="var(--surface)" stroke="var(--border)" rx="3" />
                {series.map((s, i) => {
                  const v = s.values[hover];
                  return (
                    <text key={s.id} x={hoverX + 12} y={LINE_PAD_T + 26 + i * 12} fontSize="9" fill={s.color}>
                      {s.label}: {v != null ? v.toFixed(4) : '—'}
                    </text>
                  );
                })}
              </>
            )}
          </g>
        )}
      </svg>
    </div>
  );
}

interface GroupSpec {
  title: string;
  keys: ResultsCsvKey[];
}

const GROUPS: GroupSpec[] = [
  { title: 'Losses', keys: ['trainBoxLoss', 'valBoxLoss', 'trainClsLoss', 'valClsLoss'] },
  { title: 'Metrics', keys: ['map50', 'map5095', 'precision', 'recall'] },
];

/** Single job: per-epoch curves grouped into Losses and Metrics. */
export function TrainingCurves({ artifactId }: { artifactId: string }) {
  const { data, isLoading, error } = useResultsCsv(artifactId);
  if (isLoading) return <p className="hint">Loading training curves…</p>;
  if (error || !data) return <p className="hint">Training curves unavailable.</p>;

  return (
    <div className="training-curves">
      {GROUPS.filter((g) => groupHasData(data, g.keys)).map((g) => {
        const series: LineSeries[] = g.keys
          .filter((k) => groupHasData(data, [k]))
          .map((k) => ({
            id: k,
            label: METRIC_LABEL[k],
            color: METRIC_COLOR[k],
            dash: METRIC_DASH[k] ?? null,
            values: data.series[k] ?? [],
          }));
        return (
          <div key={g.title} className="curve-card">
            <div className="curve-head">
              <h4>{g.title}</h4>
              <div className="curve-legend">
                {series.map((s) => (
                  <span key={s.id} className="curve-legend-item">
                    <i style={{ background: s.color }} />
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
            <LineGraph epochs={data.epochs} series={series} />
          </div>
        );
      })}
    </div>
  );
}

interface CompareModel {
  id: string;
  name: string;
  color: string;
  sourceTrainingJobId: string | null;
}

interface MultiModelCurvesProps {
  models: CompareModel[];
}

/**
 * The same curves overlaid for several models being compared. Each model is one
 * color; metric type is a dash pattern (solid mAP50, dashed mAP50-95, dot-dash
 * precision, dots recall). Models may have trained different numbers of epochs —
 * the x-axis spans the longest run and shorter runs simply stop.
 */
export function MultiModelCurves({ models }: MultiModelCurvesProps) {
  const queries = useQuery({
    queryKey: ['compare-artifacts', models.map((m) => m.sourceTrainingJobId).join(',')],
    queryFn: async () => {
      const byModel: Record<string, string | null> = {};
      for (const m of models) {
        if (!m.sourceTrainingJobId) { byModel[m.id] = null; continue; }
        const list = await fetch(`/api/v1/artifacts?owner_type=TRAINING_JOB&owner_id=${m.sourceTrainingJobId}`).then((r) => r.json());
        const rows = ((list as { data?: { id: string; artifact_type_code: string }[] }).data ?? []) as { id: string; artifact_type_code: string }[];
        const csv = rows.find((a) => a.artifact_type_code === 'RESULTS_CSV');
        byModel[m.id] = csv ? csv.id : null;
      }
      return byModel;
    },
    enabled: models.length > 0,
  });

  const csvQueries = useQuery({
    queryKey: ['compare-curves', models.map((m) => m.id).join(',')],
    queryFn: async () => {
      const out: Record<string, ResultsCsvData | null> = {};
      for (const m of models) {
        const artifactId = queries.data?.[m.id];
        if (!artifactId) { out[m.id] = null; continue; }
        const text = await fetch(`/api/v1/artifacts/${artifactId}/view`).then((r) => r.text());
        out[m.id] = parseResultsCsv(text);
      }
      return out;
    },
    enabled: !!queries.data && models.length > 0,
  });

  const modelData = models.map((m) => ({ m, data: csvQueries.data?.[m.id] ?? null }));
  const withData = modelData.filter((x) => x.data && (x.data.epochs.length > 0));
  if (models.length === 0) return null;
  if (queries.isLoading || csvQueries.isLoading) return <p className="hint">Loading training curves…</p>;
  if (withData.length === 0) return <p className="hint">No training curve artifacts found for the selected models.</p>;

  const maxEpochs = Math.max(...withData.map((x) => x.data!.epochs.length));
  const epochAxis = Array.from({ length: maxEpochs }, (_, i) => i + 1);

  return (
    <div className="training-curves">
      {GROUPS.map((g) => {
        const series: LineSeries[] = [];
        for (const { m, data } of withData) {
          if (!data) continue;
          for (const k of g.keys) {
            if (!(data.series[k]?.length)) continue;
            const values: (number | null)[] = Array(maxEpochs).fill(null);
            for (let i = 0; i < data.series[k]!.length; i++) values[i] = data.series[k]![i];
            series.push({ id: `${m.id}-${k}`, label: m.name, color: m.color, dash: METRIC_DASH[k] ?? null, values });
          }
        }
        if (series.length === 0) return null;
        return (
          <div key={g.title} className="curve-card">
            <div className="curve-head">
              <h4>{g.title}</h4>
              <div className="curve-legend">
                {withData.map(({ m }) => (
                  <span key={m.id} className="curve-legend-item">
                    <i style={{ background: m.color }} />
                    {m.name}
                  </span>
                ))}
              </div>
            </div>
            {g.keys.filter((k) => withData.some((x) => x.data!.series[k]?.length)).length > 1 && (
              <div className="curve-metric-legend">
                {g.keys.filter((k) => withData.some((x) => x.data!.series[k]?.length)).map((k) => (
                  <span key={k} className="curve-legend-item">
                    <i className="curve-dash" style={{ borderTop: `2px ${METRIC_DASH[k] ? 'dashed' : 'solid'} #9ba9c3` }} />
                    {METRIC_LABEL[k]}
                  </span>
                ))}
              </div>
            )}
            <LineGraph epochs={epochAxis} series={series} />
          </div>
        );
      })}
    </div>
  );
}
