import { PartialType } from '@nestjs/mapped-types';
import { CreateHoldingDto } from './create-holding.dto';

export class UpdateHoldingDto extends PartialType(CreateHoldingDto) {}
