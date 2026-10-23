import { useRef, useState } from 'react'
import EmailEditor, { type EditorRef, type EmailEditorProps } from 'react-email-editor'

function App() {
  const editorRef = useRef<EditorRef>(null)
  const [prompt, setPrompt] = useState('')
  const [showDeveloper, setShowDeveloper] = useState(false)
  const [design, setDesign] = useState<unknown>(null)
  const [status, setStatus] = useState('No design captured yet.')
  const [agentStatus, setAgentStatus] = useState('Waiting for editor...')
  const [proposalStatus, setProposalStatus] = useState('No change prepared yet.')
  const [isApplying, setIsApplying] = useState(false)
  const approvalInProgress = useRef(false)
  const [proposal, setProposal] = useState<{
    before: string
    after: string
    baseDesign: string
    candidateDesign: unknown
  } | null>(null)

  const onReady: EmailEditorProps['onReady'] = (editor) => {
    void checkAgentConnection()
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

  const checkAgentConnection = async () => {
    setAgentStatus('Checking agent connection...')
    try {
      const agent = (unlayer as unknown as { agent?: { describe: () => Promise<{ editors?: unknown[] }> } }).agent
      if (!agent) throw new Error('Agent API unavailable')
      const details = await agent.describe()
      const count = details.editors?.length ?? 0
      setAgentStatus(count > 0 ? 'Connected to ' + count + ' agent-enabled editor(s).' : 'No agent-enabled editors found.')
    } catch (error) {
      setAgentStatus(error instanceof Error ? error.message : 'Agent connection failed.')
    }
  }

  const prepareDemoEdit = async () => {
    setProposal(null)
    setProposalStatus('Preparing change...')

    try {
      const agent = (unlayer as unknown as {
        agent?: { getDesign: () => Promise<unknown> }
      }).agent

      if (!agent) throw new Error('Agent API unavailable')

      const original = await agent.getDesign()
      const candidate = structuredClone(original) as {
        body?: {
          rows?: Array<{
            columns?: Array<{
              contents?: Array<{
                type?: string
                values?: {
                  textJson?: string
                  text?: string
                  locked?: boolean
                }
              }>
            }>
          }>
        }
      }

      const paragraph = candidate.body?.rows?.[0]?.columns?.[0]?.contents?.[0]

      if (
        paragraph?.type !== 'paragraph' ||
        paragraph.values?.locked ||
        typeof paragraph.values?.textJson !== 'string' ||
        typeof paragraph.values?.text !== 'string'
      ) {
        throw new Error('First content block is not an editable paragraph.')
      }

      const richText = JSON.parse(paragraph.values.textJson) as {
        root?: {
          children?: Array<{
            children?: Array<{ text?: string }>
          }>
        }
      }

      const textNode = richText.root?.children?.[0]?.children?.[0]
      const before = textNode?.text
      const after = 'Prepared inside Unlayer Agent Lab!'

      if (!before || !textNode || !paragraph.values.text.includes(before)) {
        throw new Error('Paragraph text structure could not be safely updated.')
      }

      textNode.text = after
      paragraph.values.textJson = JSON.stringify(richText)
      paragraph.values.text = paragraph.values.text.replace(before, after)

      setProposal({
        before,
        after,
        baseDesign: JSON.stringify(original),
        candidateDesign: candidate
      })

      setProposalStatus('Proposal ready. The canvas has not been changed.')
    } catch (error) {
      setProposalStatus(
        error instanceof Error ? error.message : 'Could not prepare change.'
      )
    }
  }
  const approveProposal = async () => {
    if (!proposal || approvalInProgress.current) return

    approvalInProgress.current = true
    setIsApplying(true)
    setProposalStatus('Checking the current design...')

    try {
      const agent = (unlayer as unknown as {
        agent?: {
          getDesign: () => Promise<unknown>
          loadDesign: (design: unknown) => Promise<{
            ok: boolean
            loaded: boolean
            errors?: Array<{ message: string }>
          }>
        }
      }).agent

      if (!agent) throw new Error('Agent API unavailable')

      const current = await agent.getDesign()

      if (JSON.stringify(current) !== proposal.baseDesign) {
        setProposal(null)
        setProposalStatus(
          'The design changed after this proposal was prepared. Prepare a new proposal.'
        )
        return
      }

      localStorage.setItem(
        'unlayer-agent-lab:design:pre-approved-edit:v1',
        proposal.baseDesign
      )

      setProposalStatus('Applying approved change...')

      const result = await agent.loadDesign(proposal.candidateDesign)

      if (!result.ok || !result.loaded) {
        const explanation = result.errors?.map((error) => error.message).join('; ')
        throw new Error(explanation || 'Unlayer rejected the proposed design.')
      }

      setProposal(null)
      setProposalStatus('Approved change applied successfully.')
    } catch (error) {
      setProposalStatus(
        error instanceof Error ? error.message : 'Approval failed.'
      )
    } finally {
      approvalInProgress.current = false
      setIsApplying(false)
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
        <p role='status'>{agentStatus}</p>
        <textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder='Describe the email you want to create...' />
        <div>
          <button type='button' onClick={() => void prepareDemoEdit()}>
            Prepare Demo Edit
          </button>
        </div>
        <p role='status'>{proposalStatus}</p>
        {proposal && (
          <div>
            <h3>Proposed Change</h3>
            <p><strong>Before:</strong> {proposal.before}</p>
            <p><strong>After:</strong> {proposal.after}</p>
            <button
              type='button'
              disabled={isApplying}
              onClick={() => void approveProposal()}
            >
              {isApplying ? 'Applying...' : 'Approve Change'}
            </button>
            <button type='button' onClick={() => {
              setProposal(null)
              setProposalStatus('Proposal discarded.')
            }}>
              Discard Proposal
            </button>
          </div>
        )}
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





