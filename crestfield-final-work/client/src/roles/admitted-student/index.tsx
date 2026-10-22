import RolePortal from '../../shared/RolePortal';
import { roleConfig } from './role';
export default function AdmittedStudentPortal() { return <RolePortal title={roleConfig.title} description={roleConfig.description} links={roleConfig.links} />; }
