import { useRef, useState } from 'react'
import EmailEditor, { type EditorRef, type EmailEditorProps } from 'react-email-editor'

function App() {
  const editorRef = useRef<EditorRef>(null)
  const [prompt, setPrompt] = useState('')
  const [showDeveloper, setShowDeveloper] = useState(false)
  const [design, setDesign] = useState<unknown>(null)
  const [status, setStatus] = useState('No design captured yet.')

  const onReady: EmailEditorProps['onReady'] = (editor) => {
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    let listening = false

    const startAutosave = () => {
      if (listening) return
      listening = true
      editor.addEventListener('design:updated', () => {
        if (saveTimer) clearTimeout(saveTimer)
        setStatus('Saving changes...')
        saveTimer = setTimeout(() => {
          editor.saveDesign((result) => {
            try {
              localStorage.setItem('unlayer-agent-lab:design:v1', JSON.stringify(result))
              setStatus('All changes saved automatically.')
            } catch {
              setStatus('Autosave failed. Your latest changes may not be stored.')
            }
          })
        }, 1000)
      })
    }

    try {
      const stored = localStorage.getItem('unlayer-agent-lab:design:v1')
      if (!stored) {
        startAutosave()
        setStatus('Autosave ready.')
        return
      }
      const saved = JSON.parse(stored) as Parameters<typeof editor.loadDesign>[0]
      if (!saved || typeof saved !== 'object' || !('body' in saved)) {
        setStatus('Invalid saved design. Autosave paused.')
        return
      }
      editor.addEventListener('design:loaded', () => {
        startAutosave()
        setStatus('Saved design restored. Autosave ready.')
      })
      editor.loadDesign(saved)
      setStatus('Restoring saved design...')
    } catch {
      setStatus('Restoration failed. Autosave paused to protect saved data.')
    }
  }

  const captureDesign = () => {
    const editor = editorRef.current?.editor
    if (!editor) {
      setStatus('Editor is not ready yet.')
      return
    }
    editor.saveDesign((result) => {
      window.localStorage.setItem('unlayer-agent-lab:design:v1', JSON.stringify(result))
      setDesign(result)
      setStatus('Design saved in this browser.')
    })
  }

  return (
    <main>
      <header>
        <h1>Unlayer Agent Lab</h1>
        <button type='button' aria-pressed={showDeveloper} onClick={() => setShowDeveloper((value) => !value)}>
          {showDeveloper ? 'Hide Developer Mode' : 'Developer Mode'}
        </button>
      </header>
      <p>Human creativity meets agent-powered editing.</p>

      <section aria-label='AI instructions'>
        <h2>What would you like to create?</h2>
        <textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder='Describe the email you want to create...' />
        <div><button type='button' disabled>Generate with AI (coming soon)</button></div>
        <p>AI generation is not connected yet. Manual editing is available below.</p>
      </section>

      <section aria-label='Visual editor'>
        <h2>Visual Editor</h2>
        <p role='status'>{status}</p>
        <EmailEditor ref={editorRef} onReady={onReady} options={{ version: 'latest' }} minHeight='650px' />
      </section>

      {showDeveloper && (
        <section aria-label='Developer tools'>
          <h2>Developer Tools</h2>
          <button type='button' onClick={captureDesign}>Save Design Locally</button>
          <p role='status'>{status}</p>
          {design !== null && (
            <pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(design, null, 2)}
            </pre>
          )}
        </section>
      )}
    </main>
  )
}

export default App




