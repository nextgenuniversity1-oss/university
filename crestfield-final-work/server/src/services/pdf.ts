// Dedicated PDF service boundary. Add institution-approved templates and a PDF renderer here.
export async function generateDocument(_kind: string, _payload: unknown): Promise<Buffer> {
  throw new Error('PDF templates are not configured yet. Add an approved institutional template before generating official documents.');
}
