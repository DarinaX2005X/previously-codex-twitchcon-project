import { useState } from 'react';
import { Button, Field, IconButton, QuietButton, SegmentedControl, Select, Textarea } from './controls';
import { Dialog, Sheet } from './overlays';
import { ActionGroup, Brand, DockLayout, ReadingLayout } from './layout';
import { ChapterRow, InlineNotice, LanguageControl, MomentPlayer, SourceDisclosure, SourceStatus } from './story';
import { recapMessagesFor, type RecapLanguage } from '../i18n';

/** Temporary integration review surface. All story content is explicitly authored sample material. */
export function FoundationShowcase() {
  const [language, setLanguage] = useState<RecapLanguage>('en');
  const [filter, setFilter] = useState('published');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [title, setTitle] = useState('Keep edits after a reload');
  const [text, setText] = useState('The preview reloaded before the edit was saved. The next step is to preserve the edit across a reload.');
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftText, setDraftText] = useState(text);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState('');
  const [layout, setLayout] = useState('lower');
  const messages = recapMessagesFor(language);
  function edit() { setDraftTitle(title); setDraftText(text); setError(undefined); setSheetOpen(true); }
  function save() {
    if (!draftTitle.trim() || !draftText.trim()) { setError('Enter a title and an explanation before saving.'); return; }
    setTitle(draftTitle.trim()); setText(draftText.trim()); setSheetOpen(false); setReceipt('Sample changes saved for this visit.');
  }
  const chapter = <ChapterRow title={title} atMs={1458000} sources={<SourceDisclosure label="Read the sample source"><p>“The preview reloaded before I saved the edit. I want to keep my changes after a reload.”</p></SourceDisclosure>} actions={<><QuietButton onClick={edit}>Edit sample</QuietButton><IconButton label="Preview source" onClick={() => setPreviewOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 10 7-10 7Z" /></svg></IconButton></>}><p>{text}</p></ChapterRow>;
  return <main className="pv-showcase">
    <header className="pv-showcase__header"><Brand /><h1>Interface examples</h1></header>
    <p className="pv-showcase__intro">These controls use authored sample material. Edit the sample to review the reading surface, narrow dock and keyboard interaction.</p>
    <div className="pv-showcase__grid">
      <DockLayout aria-label="Example narrow dock" header={<>
        <h2>Recap controls</h2>
        <div className="pv-showcase__statuses"><SourceStatus label="Microphone paused" state="paused" observation="No speech is being captured." /><SourceStatus label="Chat not connected" state="unavailable" observation="No chat has been observed." /></div>
        <ActionGroup><Button onClick={() => setPreviewOpen(true)}>Preview sample</Button><QuietButton onClick={edit}>Edit sample</QuietButton></ActionGroup>
        <LanguageControl value={language} onChange={setLanguage} options={['en', 'ru']} />
      </>}>
        <SegmentedControl label="Example chapter collection" value={filter} onChange={setFilter} options={[{ value: 'published', label: 'Published' }, { value: 'drafts', label: 'Drafts' }, { value: 'held', label: 'Held' }]} />
        {filter === 'published' ? <div className="pv-showcase__draft" data-theme="light" style={{ marginTop: 20 }}>{chapter}</div> : <div style={{ marginTop: 20 }}><InlineNotice>{filter === 'drafts' ? 'There are no sample drafts.' : 'There are no sample items that need review.'}</InlineNotice></div>}
      </DockLayout>
      <ReadingLayout aria-label="Example reading surface">
        <div className="pv-showcase__reading-header"><h2>Recorded stream sample</h2><QuietButton onClick={() => setPreviewOpen(true)}>Open source</QuietButton></div>
        <div className="pv-showcase__current" lang={language}><span>{messages.whatMattersNow}</span><h2>{language === 'en' ? 'Keep the live preview from losing an edit' : 'Сохранить изменения при перезагрузке предпросмотра'}</h2><p>{language === 'en' ? 'The current investigation follows a reload that cleared an unsaved edit.' : 'Сейчас разбираются с перезагрузкой, после которой исчезли несохранённые изменения.'}</p></div>
        {chapter}
        {receipt && <InlineNotice tone="success" live>{receipt}</InlineNotice>}
        <div className="pv-showcase__controls"><Select label="Scene position" value={layout} onChange={event => setLayout(event.target.value)} options={[{ value: 'lower', label: 'Lower part of the screen' }, { value: 'left', label: 'Left side of the screen' }, { value: 'right', label: 'Right side of the screen' }]} /><InlineNotice tone="warning">Clip unavailable. The sample source text and time remain readable.</InlineNotice><ActionGroup><Button pending>Save changes</Button><QuietButton disabled>Watch recording</QuietButton></ActionGroup></div>
      </ReadingLayout>
    </div>
    <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="Edit the sample chapter" description="Changes apply to this example for the current visit." footer={<><QuietButton onClick={() => setSheetOpen(false)}>Cancel</QuietButton><Button onClick={save}>Save changes</Button></>}>
      <Field label="Chapter title" value={draftTitle} onChange={event => setDraftTitle(event.target.value)} maxLength={180} error={error && !draftTitle.trim() ? 'Enter a chapter title.' : undefined} />
      <Textarea label="What changed" value={draftText} onChange={event => setDraftText(event.target.value)} maxLength={2000} error={error && !draftText.trim() ? 'Explain what changed.' : undefined} />
      {error && <InlineNotice tone="danger" live>{error}</InlineNotice>}
    </Sheet>
    <Dialog open={previewOpen} onOpenChange={setPreviewOpen} title="Sample source" footer={<QuietButton onClick={() => setPreviewOpen(false)}>Close source</QuietButton>}>
      <MomentPlayer title="The preview reloaded" atMs={1458000} sourceText="The preview reloaded before I saved the edit." unavailableMessage="This authored sample has no video. Its source passage and time show the fallback layout." />
    </Dialog>
  </main>;
}
