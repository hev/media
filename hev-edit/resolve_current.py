"""Preserve Resolve's current project without opening an interactive save dialog."""
def preserve_current(pm, current, job_name):
    if not current:
        return
    saved = pm.GetProjectListInCurrentFolder() or []
    if current.GetName() not in saved:
        folder = current.GetMediaPool().GetRootFolder()
        empty = current.GetTimelineCount() == 0 and not folder.GetClipList() and not folder.GetSubFolderList()
        if not empty:
            raise RuntimeError('Save the current unnamed Resolve project before building a handoff')
        preserved = job_name + '-empty-before-build'
        if preserved in saved or not current.SetName(preserved):
            raise RuntimeError('Could not preserve the empty unnamed Resolve project')
    if not pm.SaveProject():
        raise RuntimeError('Could not save current Resolve project; refusing to switch')
    if not pm.CloseProject(current):
        raise RuntimeError('Could not close current project safely')
