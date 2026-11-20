import { useEffect, useState } from 'react';
import {
  officialAgriculturalApi,
  type OfficialDatabaseStatus,
  type OfficialRetrievalResponse,
} from '../../services/officialAgriculturalApi';

const suggestedQueries = [
  'What subsidies are available for jasmine cultivation?',
  'How can I control bud worm in jasmine?',
  'What planting material support is available for jasmine farmers?',
  'Are there loans for jasmine polyhouses or greenhouses?',
];

const categoryLabels: Record<string, string> = {
  jasmine_crop_practice: 'Crop Practice',
  floriculture_subsidy: 'Subsidy',
  horticulture_scheme: 'Scheme',
  jasmine_planting_material: 'Planting Material',
  pest_management: 'Pest Management',
  irrigation: 'Irrigation',
  agricultural_credit: 'Credit / Loan',
  market_information: 'Market',
  state_scheme: 'State Scheme',
};

function categoryLabel(category?: string): string | undefined {
  return category ? categoryLabels[category] ?? category : undefined;
}

export default function OfficialAgriculturalPage() {
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState<OfficialRetrievalResponse | null>(null);
  const [databaseStatus, setDatabaseStatus] = useState<OfficialDatabaseStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [deepSearching, setDeepSearching] = useState(false);
  const [error, setError] = useState('');

  const refreshStatus = () =>
    officialAgriculturalApi
      .getDatabaseStatus()
      .then(setDatabaseStatus)
      .catch(() => setError('Official agricultural service is not running.'));

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function askQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = message.trim();
    if (query.length < 3) {
      setError('Enter an agricultural question with at least 3 characters.');
      return;
    }

    setLoading(true);
    setError('');
    setResponse(null);
    try {
      setResponse(await officialAgriculturalApi.ask(query));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }

  async function updateKnowledgeBase() {
    setDeepSearching(true);
    setError('');
    try {
      const result = await officialAgriculturalApi.triggerDeepSearch();
      if (!result.triggered) {
        setError(result.reason ?? 'The knowledge-base update is not currently due.');
      } else {
        setError(result.message ?? 'Knowledge-base update started in the background.');
      }
      await refreshStatus();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Knowledge-base update failed.');
    } finally {
      setDeepSearching(false);
    }
  }

  return (
    <main className="h-full overflow-y-auto bg-[var(--bg-base)]">
      <div className="mx-auto max-w-5xl px-5 py-8 md:px-10">
        <header className="mb-8">
          <p className="mb-2 text-sm font-medium text-emerald-400">Official sources</p>
          <h1 className="text-3xl font-semibold text-[var(--text-primary)]">
            Agricultural Web Retrieval
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
            Search verified government and agricultural institution pages for
            schemes, cultivation guidance, pest management, and farmer support.
          </p>
          {databaseStatus && (
            <p className="mt-4 text-xs text-[var(--text-muted)]">
              {databaseStatus.page_count ?? 0} pages · {databaseStatus.chunk_count ?? 0} indexed chunks
            </p>
          )}
        </header>

        <section className="rounded-3xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 shadow-sm md:p-7">
          <div className="mb-5 flex flex-wrap gap-2">
            {suggestedQueries.map((query) => (
              <button
                key={query}
                type="button"
                onClick={() => setMessage(query)}
                className="rounded-full border border-[var(--border)] px-3 py-2 text-left text-xs text-[var(--text-secondary)] transition hover:border-emerald-500/60 hover:text-[var(--text-primary)]"
              >
                {query}
              </button>
            ))}
          </div>

          <form onSubmit={askQuestion}>
            <label htmlFor="official-agricultural-question" className="sr-only">
              Agricultural question
            </label>
            <textarea
              id="official-agricultural-question"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Ask about an official agricultural scheme or practice..."
              rows={4}
              className="w-full resize-y rounded-2xl border border-[var(--border)] bg-[var(--bg-base)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none transition focus:border-emerald-500"
            />
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={loading}
                className="rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? 'Searching verified sources...' : 'Search Official Sources'}
              </button>
              <button
                type="button"
                disabled={deepSearching}
                onClick={() => void updateKnowledgeBase()}
                className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm text-[var(--text-secondary)] transition hover:bg-[var(--bg-surface-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deepSearching ? 'Updating knowledge base...' : 'Update Knowledge Base'}
              </button>
            </div>
          </form>

          {error && (
            <p role="status" className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              {error}
            </p>
          )}
        </section>

        {response && (
          <section className="mt-6 rounded-3xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 md:p-7">
            <div className="flex flex-wrap gap-2 text-xs">
              {categoryLabel(response.query_understanding?.category) && (
                <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-300">
                  {categoryLabel(response.query_understanding?.category)}
                </span>
              )}
              {response.query_understanding?.location && (
                <span className="rounded-full bg-[var(--bg-surface-hover)] px-3 py-1 text-[var(--text-secondary)]">
                  {response.query_understanding.location}
                </span>
              )}
            </div>
            <h2 className="mt-5 text-xl font-semibold text-[var(--text-primary)]">Answer</h2>
            <div className="mt-3 space-y-2 text-sm leading-7 text-[var(--text-secondary)]">
              {(response.answer ?? 'No answer was returned.').split('\n').map((line, index) => (
                <p key={`${index}-${line}`}>{line}</p>
              ))}
            </div>

            {response.sources && response.sources.length > 0 && (
              <>
                <h3 className="mt-8 text-lg font-semibold text-[var(--text-primary)]">
                  Official Source Pages
                </h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {response.sources.map((source) => (
                    <a
                      key={source.page_url}
                      href={source.page_url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-2xl border border-[var(--border)] p-4 transition hover:border-emerald-500/60 hover:bg-[var(--bg-surface-hover)]"
                    >
                      <p className="text-xs font-medium text-emerald-400">
                        {source.source_name ?? 'Official source'}
                      </p>
                      <p className="mt-2 text-sm font-medium text-[var(--text-primary)]">
                        {source.page_title ?? 'Open official page'}
                      </p>
                      {source.section && (
                        <p className="mt-1 text-xs text-[var(--text-muted)]">{source.section}</p>
                      )}
                      <p className="mt-3 text-xs text-emerald-400">Open exact page ↗</p>
                    </a>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
