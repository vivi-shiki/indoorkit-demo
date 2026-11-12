import { buildVenueModel } from '@indoorkit/imdf';
import { createParking, type Parking, parkingExtensions } from '@indoorkit/parking';
import { generateParking, MINATO_PARKING } from '@indoorkit/venue-gen';

/** 和浏览器、device-sim 同一份虚构停车场 */
export const PARKING: Parking = createParking(
  buildVenueModel(generateParking(MINATO_PARKING), parkingExtensions),
);
