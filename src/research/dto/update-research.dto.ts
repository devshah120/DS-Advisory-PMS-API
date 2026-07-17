import { PartialType } from '@nestjs/mapped-types';
import { CreateResearchDto } from './create-research.dto';

export class UpdateResearchDto extends PartialType(CreateResearchDto) {}
