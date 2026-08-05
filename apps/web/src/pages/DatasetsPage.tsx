import { SourceDatasetsPage } from './SourceDatasetsPage';
import { TrainingDatasetsPage } from './TrainingDatasetsPage';
import { useUiStore } from '../stores/ui';

export function DatasetsPage() {
  const tab = useUiStore((s) => s.datasetTab);
  const setTab = useUiStore((s) => s.setDatasetTab);

  return (
    <section className="page">
      <div className="subnav">
        <button
          className={`subnav-btn${tab === 'source' ? ' active' : ''}`}
          onClick={() => setTab('source')}
        >
          Source
        </button>
        <button
          className={`subnav-btn${tab === 'training' ? ' active' : ''}`}
          onClick={() => setTab('training')}
        >
          Training
        </button>
      </div>
      {tab === 'source' && <SourceDatasetsPage />}
      {tab === 'training' && <TrainingDatasetsPage />}
    </section>
  );
}
