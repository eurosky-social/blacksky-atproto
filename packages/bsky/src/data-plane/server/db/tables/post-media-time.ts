// Eurosky: a reply that names a second of the video it answers.
export const tableName = 'post_media_time'

export interface PostMediaTime {
  postUri: string
  parentUri: string
  seconds: number
}

export type PartialDB = {
  [tableName]: PostMediaTime
}
