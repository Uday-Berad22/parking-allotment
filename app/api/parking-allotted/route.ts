

import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import { Db, ObjectId } from 'mongodb';

interface Booking {
  _id: ObjectId;
  user_id: string;
  created_at: Date;
  status: string;
}

interface User {
  user_id: string;
  used_tokens: number;
}

interface Allocation {
  user_id: string;
  parking_spot: string;
  booking_id: ObjectId;
}

export async function POST() {
  try {
    const db = await getDatabase();

    // Get all pending bookings
    const pendingBookings: Booking[] = await db.collection('bookings')
      .find({ status: 'pending' })
      .toArray() as Booking[];

    // Get available parking spots
    const availableSpots = 8; // Assuming 8 spots are available

    // Sort bookings by priority
    const sortedBookings = await sortBookingsByPriority(db, pendingBookings, availableSpots);

    // Allocate parking spots
    const allocations: Allocation[] = sortedBookings.map((booking, index) => ({
      user_id: booking.user_id,
      parking_spot: `Spot ${index + 1}`,
      booking_id: booking._id
    }));

    // Update bookings and create allocations
    await Promise.all([
      ...allocations.map((allocation: Allocation) => 
        db.collection('bookings').updateOne(
          { _id: allocation.booking_id },
          { $set: { status: 'allocated' } }
        )
      ),
      db.collection('allocations').insertMany(allocations)
    ]);

    return NextResponse.json({ message: 'Parking allocated successfully' }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ message: 'Error allocating parking' }, { status: 500 });
  }
}

async function sortBookingsByPriority(db: Db, bookings: Booking[], numToSelect: number): Promise<Booking[]> {
  const userIds = bookings.map(booking => booking.user_id);
  const users: User[] = await db.collection('users')
    .find({ user_id: { $in: userIds } })
    .toArray() as unknown as User[];

  const userMap: { [key: string]: User } = users.reduce((map: { [key: string]: User }, user: User) => {
    map[user.user_id] = user;
    return map;
  }, {});

  const usersWithTokens: [string, number][] = bookings.map(booking => [booking.user_id, userMap[booking.user_id]?.used_tokens || 0]);

  function selectIds(users: [string, number][], numToSelect: number): string[] {
    users.sort((a, b) => a[1] - b[1]);
    const groups: { [key: number]: string[] } = {};
    for (const [id, tokens] of users) {
      if (!groups[tokens]) {
        groups[tokens] = [];
      }
      groups[tokens].push(id);
    }
    const selectedIds: string[] = [];
    const tokenCounts = Object.keys(groups).map(Number).sort((a, b) => a - b);
    for (const tokenCount of tokenCounts) {
      const group = groups[tokenCount];
      if (group.length + selectedIds.length <= numToSelect) {
        selectedIds.push(...group);
      } else {
        const remaining = numToSelect - selectedIds.length;
        const shuffled = group.sort(() => 0.5 - Math.random());
        selectedIds.push(...shuffled.slice(0, remaining));
      }
      if (selectedIds.length === numToSelect) {
        break;
      }
    }
    for (const id of selectedIds) {
      const user = users.find(user => user[0] === id);
      if (user) {
        user[1]++;
      }
    }
    return selectedIds;
  }

  const selectedIds = selectIds(usersWithTokens, numToSelect);
  
  // Update used_tokens in the database
  await Promise.all(selectedIds.map(id => 
    db.collection('users').updateOne(
      { user_id: id },
      { $inc: { used_tokens: 1 } }
    )
  ));

  return bookings.filter(booking => selectedIds.includes(booking.user_id));
}