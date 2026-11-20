import { Router } from 'express';
import {
  handleOfficialChat,
  handleOfficialDatabaseStatus,
  handleOfficialDeepSearch,
  handleOfficialHealth,
  handleOfficialReloadChroma,
  handleOfficialSearch,
  handleOfficialSources,
} from '../controllers/officialAgriculturalController';

const router = Router();

router.get('/health', handleOfficialHealth);
router.get('/db-status', handleOfficialDatabaseStatus);
router.get('/sources', handleOfficialSources);
router.post('/chat', handleOfficialChat);
router.post('/search', handleOfficialSearch);
router.post('/deep-search', handleOfficialDeepSearch);
router.post('/admin/reload-chroma', handleOfficialReloadChroma);

export default router;
