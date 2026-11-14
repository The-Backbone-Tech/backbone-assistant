// The dated upstream list is a classification ceiling: a new name never inherits a read grant.
import type { CatalogueId, CataloguePreset } from '../api-catalogue.ts';
import type { ListedTool, ServerLaunch } from './client.ts';
import { kindOf } from './classification.ts';
export { CONNECTOR_CATALOGUE } from '../api-catalogue.ts';

export const CATALOGUE_READS: Record<CatalogueId, readonly string[]> = {
  calendar: ['list_calendars', 'get_events', 'query_freebusy'],
  drive: ['search_drive_files', 'get_drive_file_content', 'get_drive_file_download_url', 'list_drive_items', 'get_drive_file_permissions', 'check_drive_file_public_access'],
  github: ['get_commit', 'get_file_contents', 'get_label', 'get_latest_release', 'get_me', 'get_release_by_tag', 'get_tag', 'get_team_members', 'get_teams', 'issue_read', 'list_branches', 'list_commits', 'list_issue_fields', 'list_issue_types', 'list_issues', 'list_pull_requests', 'list_releases', 'list_repository_collaborators', 'list_tags', 'pull_request_read', 'search_code', 'search_commits', 'search_issues', 'search_pull_requests', 'search_repositories', 'search_users', 'ui_get'],
  // Slack is a configuration dependency. These documented read names still require live read hints.
  slack: ['slack_search_all', 'slack_search_messages', 'slack_search_channels', 'slack_search_users', 'slack_read_channel', 'slack_read_thread', 'slack_read_file', 'slack_read_canvas', 'slack_get_user_info', 'slack_get_reactions', 'slack_list_channel_members', 'slack_list_user_channels'],
};
export const CATALOGUE_EFFECTS: Record<CatalogueId, readonly string[]> = {
  calendar: ['manage_event', 'manage_out_of_office', 'manage_focus_time', 'manage_calendar', 'start_google_auth'],
  drive: ['get_drive_shareable_link', 'create_drive_folder', 'create_drive_file', 'import_to_google_doc', 'import_to_google_slides', 'import_to_google_sheets', 'update_drive_file', 'manage_drive_access', 'copy_drive_file', 'set_drive_file_permissions', 'start_google_auth'],
  github: ['add_comment_to_pending_review', 'add_issue_comment', 'add_reply_to_pull_request_comment', 'assign_copilot_to_issue', 'create_branch', 'create_or_update_file', 'create_pull_request', 'create_repository', 'delete_file', 'fork_repository', 'issue_write', 'merge_pull_request', 'pull_request_review_write', 'push_files', 'request_copilot_review', 'sub_issue_write', 'update_issue_comment', 'update_pull_request', 'update_pull_request_branch'],
  slack: ['slack_send_message', 'slack_schedule_message', 'slack_create_canvas', 'slack_update_canvas', 'slack_add_reaction', 'slack_get_file_upload_url', 'slack_complete_file_upload'],
};
export const catalogueId = (id: unknown): id is CatalogueId => typeof id === 'string' && Object.hasOwn(CATALOGUE_READS, id);
export const catalogueServerId = (id: CatalogueId) => `home:catalogue-${id}`;
export function catalogueClass(id: CatalogueId, name: string, annotations: ListedTool['annotations']): 'read' | 'effect' {
  return CATALOGUE_READS[id].includes(name) ? kindOf({ name, description: '', inputSchema: {}, annotations }) : 'effect';
}

export function catalogueLaunch(id: CatalogueId, executable?: string, preset: CataloguePreset = 'reads'): ServerLaunch {
  if (id === 'calendar' || id === 'drive') return {
    transport: 'stdio', command: executable,
    args: ['--single-user', '--tools', id === 'calendar' ? 'calendar' : 'drive', ...(preset === 'reads' ? ['--read-only'] : [])],
  };
  if (id === 'github') return { transport: 'stdio', command: executable, args: ['stdio', ...(preset === 'reads' ? ['--read-only'] : [])] };
  return { transport: 'http', url: 'https://mcp.slack.com/mcp' };
}
