import { useState } from 'react';
import { ChevronRight, ChevronDown, FileCode2, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import type { FileNode } from '../../shared/contracts';
import { projectRoute, useResource } from '../api';
import { useApp } from '../state';
import { Empty, ErrorBox, Loading } from './ui';
export function FileTree({ onOpen, selected }: {
    onOpen: (path: string) => void;
    selected: string;
}) {
    const { project } = useApp();
    return <aside className="file-explorer"><header><span>EXPLORATEUR</span><span className="badge">LOCAL</span></header>{project ? <><div className="tree-project"><FolderOpen size={16}/><strong>{project.name}</strong></div><Directory path="" depth={0} onOpen={onOpen} selected={selected}/></> : <Empty title="Aucun dossier ouvert" detail="Le connecteur n’a encore transmis aucun fichier."/>}</aside>;
}
function Directory({ path, depth, onOpen, selected }: {
    path: string;
    depth: number;
    onOpen: (path: string) => void;
    selected: string;
}) {
    const { api, projectId } = useApp();
    const files = useResource<FileNode[]>(api, projectId ? `${projectRoute(projectId, 'files')}?path=${encodeURIComponent(path)}` : null);
    return <div className="tree-directory"><ErrorBox error={files.error} retry={files.refresh}/>{files.loading && <Loading />}{files.data?.map(node => <TreeNode key={node.path} node={node} depth={depth} onOpen={onOpen} selected={selected}/>)}{files.data?.length === 0 && <small className="tree-empty">Dossier vide</small>}{depth === 0 && <button className="tree-refresh" onClick={files.refresh}><RefreshCw size={12}/>Actualiser les fichiers</button>}</div>;
}
function TreeNode({ node, depth, onOpen, selected }: {
    node: FileNode;
    depth: number;
    onOpen: (path: string) => void;
    selected: string;
}) {
    const [open, setOpen] = useState(false);
    return <><button className={`tree-node ${node.path === selected ? 'selected' : ''}`} style={{ paddingLeft: 12 + depth * 12 }} onClick={() => node.type === 'directory' ? setOpen(!open) : onOpen(node.path)} title={node.path} aria-expanded={node.type === 'directory' ? open : undefined}>{node.type === 'directory' ? <>{open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<Folder size={14}/></> : <><span className="tree-spacer"/><FileCode2 size={14}/></>}<span>{node.name}</span></button>{open && node.type === 'directory' && <Directory path={node.path} depth={depth + 1} onOpen={onOpen} selected={selected}/>}</>;
}
